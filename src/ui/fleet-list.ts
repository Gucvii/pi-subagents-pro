/** Tree-shaped, process-wide FleetView rendered below the editor. */
import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import type { AgentLineage, AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { type AgentActivity, formatTurns, getDisplayName, type Theme } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import { type FleetOwnerProvider, isFleetOwnerRegistered, listFleetAgentHandles, registerFleetOwner } from "./fleet-registry.js";
import { agentFleetKey, buildFleetTree, isValidFleetCurrentLineage, mainFleetKey, type VisibleFleetNode, visibleFleetPreorder } from "./fleet-tree.js";

const FLEET_KEY = "fleet";
const MAX_AGENT_ROWS = 5;
const TICK_MS = 1000;
const FINISHED_LINGER_MS = 4000;

export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact}`;
}

export function rightAlign(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightW = visibleWidth(right);
  if (rightW >= width) return truncateToWidth(right, width);
  const maxLeft = width - rightW - 1;
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return leftClamped + " ".repeat(gap) + right;
}

interface FleetViewState {
  current: AgentLineage;
  tree: ReturnType<typeof buildFleetTree>;
  visible: VisibleFleetNode[];
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private enabled = true;
  private active = false;
  /** Manual hide survives navigation exit, but not a genuinely empty tree. */
  private dismissed = false;
  private selectedKey: string | undefined;
  private collapsed = new Set<string>();
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  private currentIdentity: AgentLineage | undefined;
  private suspended = true;
  private viewerEpoch = 0;
  private unregisterOwner: (() => void) | undefined;
  private disposed = false;
  private provider: FleetOwnerProvider;

  constructor(
    manager: AgentManager,
    agentActivity: Map<string, AgentActivity>,
  ) {
    this.provider = {
      owner: manager,
      listAgents: () => manager.listAgents(),
      getActivity: (id) => agentActivity.get(id),
      abort: (id) => manager.abort(id),
      steer: (id, message) => manager.steer(id, message),
    };
  }

  /** Root currently projected by Fleet; absent while unbound or session-switch suspended. */
  getCurrentRootAgentId(): string | undefined {
    return this.suspended ? undefined : this.currentIdentity?.rootAgentId;
  }

  /** Bound session identity; registration begins only after a real session_start. */
  setCurrentIdentity(identity: AgentLineage): void {
    if (this.disposed || !isValidFleetCurrentLineage(identity)) return;
    this.unregisterOwner ??= registerFleetOwner(this.provider);
    const changed = this.suspended
      || this.currentIdentity?.agentId !== identity.agentId
      || this.currentIdentity.rootAgentId !== identity.rootAgentId;
    this.suspended = false;
    this.currentIdentity = { ...identity };
    if (changed) {
      this.dismissed = false;
      this.selectedKey = mainFleetKey(identity.agentId);
      this.collapsed.clear();
    }
    this.update();
  }

  /** Suspend only the session UI; the registered manager can still own background Agents. */
  onSessionBeforeSwitch(): void {
    if (this.disposed) return;
    this.viewerEpoch += 1;
    const close = this.viewerClose;
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.suspended = true;
    this.currentIdentity = undefined;
    this.active = false;
    this.dismissed = false;
    this.selectedKey = undefined;
    this.collapsed.clear();
    close?.();
    this.update();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.active = false;
      this.dismissed = false;
    }
    this.update();
  }

  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.onSessionBeforeSwitch();
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.unregisterOwner?.();
    this.unregisterOwner = undefined;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.ui = undefined;
  }

  update(): void {
    if (!this.ui) return;
    const view = this.viewState();
    const treeHasAgents = Boolean(view && view.tree.byKey.size > 1);

    // Disabled/suspended/empty are true teardown states. A manual dismissal is
    // only a render state: retain the one widget component (and its TUI focus
    // context) so restoration cannot guess who currently owns the keyboard.
    if (!this.enabled || !treeHasAgents) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      this.active = false;
      if (!treeHasAgents) this.dismissed = false;
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      if (view) this.selectedKey = mainFleetKey(view.current.agentId);
      return;
    }

    this.reconcileSelection(view!);
    this.ensureTimer();
    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (width: number) => this.renderBar(width, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  private eligibleHandles(): { current: AgentLineage; handles: ReturnType<typeof listFleetAgentHandles> } | undefined {
    if (this.suspended || !this.currentIdentity) return undefined;
    const now = Date.now();
    const current = this.currentIdentity;
    const rooted = listFleetAgentHandles().filter(({ record }) =>
      record.lineage?.rootAgentId === current.rootAgentId);
    // Every same-root record may be needed as a structural ancestor, even when its
    // completed session has already been released. Only starting display nodes require
    // an open session (or the special queued-before-session state).
    const candidates = rooted.filter(({ record }) => Boolean(record.session) || record.status === "queued");
    const byId = new Map(rooted.map(handle => [handle.record.id, handle]));
    const included = new Map<string, (typeof rooted)[number]>();

    for (const handle of candidates) {
      const { record } = handle;
      const baseEligible = record.status === "running" || record.status === "queued"
        || record.id === this.viewingAgentId
        || (record.completedAt != null && now - record.completedAt < FINISHED_LINGER_MS);
      if (!baseEligible) continue;

      included.set(record.id, handle);
      // Preserve real, live-record ancestor handles for eligible descendants. The
      // tree builder still validates every edge and exposes genuinely absent parents.
      let parentId = record.lineage.parentAgentId;
      const seen = new Set<string>([record.id]);
      while (parentId && parentId !== current.agentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) break;
        included.set(parent.record.id, parent);
        parentId = parent.record.lineage.parentAgentId;
      }
    }
    return { current, handles: [...included.values()] };
  }

  private viewState(): FleetViewState | undefined {
    const roster = this.eligibleHandles();
    if (!roster) return undefined;
    const tree = buildFleetTree(roster.current, roster.handles);
    return { current: roster.current, tree, visible: visibleFleetPreorder(tree, this.collapsed) };
  }

  private reconcileSelection(view: FleetViewState): void {
    const mainKey = mainFleetKey(view.current.agentId);
    this.selectedKey ??= mainKey;
    if (view.visible.some(entry => entry.node.key === this.selectedKey)) return;
    let node = view.tree.byKey.get(this.selectedKey);
    while (node?.parent && !view.visible.some(entry => entry.node.key === node!.parent!.key)) node = node.parent;
    this.selectedKey = node?.parent?.key ?? (node && view.visible.some(entry => entry.node === node) ? node.key : mainKey);
  }

  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui || isKeyRelease(data) || this.viewerClose) return undefined;
    const focus = this.editorFocusState();
    if (focus === "other") {
      if (this.active) this.deactivate();
      return undefined;
    }
    // Before the widget has rendered, unknown focus historically means the prompt
    // and keeps initial activation responsive. Once manually hidden, however,
    // restoration is allowed only with affirmative Editor focus: unknown must
    // fail open, and selectors/menus must always retain their keys.
    if (this.dismissed && focus !== "editor") return undefined;
    const view = this.viewState();
    if (!view || view.tree.byKey.size <= 1) return undefined;
    this.reconcileSelection(view);

    if (!this.active) {
      if ((matchesKey(data, "down") || matchesKey(data, "left")) && this.ui.getEditorText() === "") {
        this.dismissed = false;
        this.active = true;
        this.selectedKey = mainFleetKey(view.current.agentId);
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    const index = Math.max(0, view.visible.findIndex(entry => entry.node.key === this.selectedKey));
    const selected = view.visible[index]?.node ?? view.tree.main;
    if (matchesKey(data, "down")) {
      this.selectedKey = view.visible[Math.min(view.visible.length - 1, index + 1)].node.key;
    } else if (matchesKey(data, "up")) {
      if (selected.kind === "main") {
        this.dismissed = true;
        this.deactivate();
        return { consume: true };
      }
      this.selectedKey = view.visible[Math.max(0, index - 1)].node.key;
    } else if (matchesKey(data, "left")) {
      if (selected.children.length > 0 && !this.collapsed.has(selected.key)) this.collapsed.add(selected.key);
      else if (selected.parent) this.selectedKey = selected.parent.key;
      else if (selected.kind === "main") { this.deactivate(); return { consume: true }; }
      else this.selectedKey = mainFleetKey(view.current.agentId);
    } else if (matchesKey(data, "right")) {
      if (selected.children.length > 0 && this.collapsed.has(selected.key)) this.collapsed.delete(selected.key);
      else if (selected.children.length > 0) this.selectedKey = selected.children[0].key;
    } else if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    } else if (matchesKey(data, Key.enter)) {
      this.openSelected(view);
      return { consume: true };
    } else {
      this.deactivate();
      return undefined;
    }
    this.update();
    return { consume: true };
  }

  private editorFocusState(): "editor" | "other" | "unknown" {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    if (focused == null) return "unknown";
    return focused instanceof Editor ? "editor" : "other";
  }

  private deactivate(): void {
    this.active = false;
    const current = this.currentIdentity ?? this.viewState()?.current;
    if (current) this.selectedKey = mainFleetKey(current.agentId);
    this.update();
  }

  private openSelected(view = this.viewState()): void {
    if (!view) return;
    this.reconcileSelection(view);
    const node = view.tree.byKey.get(this.selectedKey ?? "");
    if (!node || node.kind === "main" || !node.handle) {
      this.deactivate();
      return;
    }
    if (!this.isTrustedSubtreeNode(node, view.tree.main)) return;
    const { record, provider } = node.handle;
    if (!this.ui) return;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.safeActivity(provider, record.id);
    const epoch = ++this.viewerEpoch;
    this.viewingAgentId = record.id;
    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        if (epoch === this.viewerEpoch && !this.suspended) this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui, session, record, activity, theme, done,
          () => {
            if (!this.authorizeViewerAction(epoch, record.id, provider)) return;
            let stopped = false;
            try { stopped = provider.abort(record.id); } catch { /* isolate foreign manager failures */ }
            if (stopped) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => {
            if (!this.authorizeViewerAction(epoch, record.id, provider)) return false;
            try { return provider.steer(record.id, message); } catch { return false; }
          },
        );
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` } },
    ).then(() => this.clearViewer(epoch, record.id), () => this.clearViewer(epoch, record.id));
  }

  private isTrustedSubtreeNode(
    node: ReturnType<typeof buildFleetTree>["main"],
    main: ReturnType<typeof buildFleetTree>["main"],
  ): boolean {
    let cursor = node;
    while (cursor !== main) {
      if (cursor.orphan || !cursor.parent) return false;
      cursor = cursor.parent;
    }
    return true;
  }

  private authorizeViewerAction(epoch: number, agentId: string, provider: FleetOwnerProvider): boolean {
    if (this.disposed || this.suspended || epoch !== this.viewerEpoch || !this.currentIdentity) return false;
    if (!isFleetOwnerRegistered(provider)) return false;
    const view = this.viewState();
    const node = view?.tree.byKey.get(agentFleetKey(agentId));
    return Boolean(node?.handle
      && node.handle.provider === provider
      && node.handle.record.id === agentId
      && this.isTrustedSubtreeNode(node, view!.tree.main));
  }

  private clearViewer(epoch: number, agentId: string): void {
    if (epoch !== this.viewerEpoch) return;
    if (!this.suspended && this.currentIdentity) this.selectedKey = agentFleetKey(agentId);
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.update();
  }

  private renderBar(width: number, theme: Theme): string[] {
    if (!this.enabled || this.dismissed || width <= 0) return [];
    const view = this.viewState();
    if (!view || view.tree.byKey.size <= 1) return [];
    this.reconcileSelection(view);
    const hint = this.active
      ? "↑↓ move · ↑ at top hide · ←→ collapse/open · enter view · esc back"
      : "esc to interrupt · ←/↓ manage";
    const lines = [truncateToWidth(`  ${theme.fg("dim", hint)}`, width), ""];
    const mainVisible = view.visible[0];
    lines.push(this.renderNode(mainVisible, width, theme));

    const agents = view.visible.slice(1);
    const selectedAgentIndex = Math.max(0, agents.findIndex(entry => entry.node.key === this.selectedKey));
    const visibleCount = Math.min(MAX_AGENT_ROWS, agents.length);
    const start = selectedAgentIndex < visibleCount ? 0 : selectedAgentIndex - visibleCount + 1;
    const hiddenBelow = agents.length - (start + visibleCount);
    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (const entry of agents.slice(start, start + visibleCount)) lines.push(this.renderNode(entry, width, theme));
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
    return lines.map(line => truncateToWidth(line, width));
  }

  private renderNode(entry: VisibleFleetNode, width: number, theme: Theme): string {
    const { node } = entry;
    const selected = node.key === this.selectedKey;
    const bullet = selected ? theme.fg("accent", "⏺") : theme.fg("dim", "◯");
    const disclosure = node.children.length > 0 ? (this.collapsed.has(node.key) ? "▸" : "▾") : " ";
    if (node.kind === "main") return truncateToWidth(`  ${bullet} ${disclosure} ${theme.bold("main")}`, width);

    const prefix = entry.ancestorContinues.map(continues => continues ? "│  " : "   ").join("") + (entry.isLast ? "└─ " : "├─ ");
    const record = node.handle!.record;
    const orphan = node.orphan ? theme.fg("warning", " orphan") : "";
    const displayType = getDisplayName(record.type);
    const type = displayType === "Agent" ? "" : theme.fg("dim", ` (${displayType})`);
    const description = this.descriptionPresentation(record, theme);
    const activity = this.safeActivity(node.handle!.provider, record.id);
    const metadata = this.metadataPresentation(record, activity, theme);
    // Metadata deliberately trails the semantic identity. rightAlign clamps the
    // left tail first, so narrow terminals preserve the tree/description and the
    // fixed elapsed/token block rather than wrapping a second details row.
    const left = `  ${prefix}${bullet} ${disclosure} ${description}${type}${orphan}${metadata}`;
    const tokens = getLifetimeTotal(activity?.lifetimeUsage ?? record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt;
    const right = theme.fg("dim", `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}`);
    return rightAlign(left, right, width);
  }

  private safeActivity(provider: FleetOwnerProvider, agentId: string): AgentActivity | undefined {
    try { return provider.getActivity(agentId); } catch { return undefined; }
  }

  private metadataPresentation(record: AgentRecord, activity: AgentActivity | undefined, theme: Theme): string {
    const parts: string[] = [];
    const modelName = record.invocation?.modelName;
    if (modelName) parts.push(modelName.includes("/") ? modelName.slice(modelName.indexOf("/") + 1) : modelName);
    if (record.invocation?.thinking) parts.push(record.invocation.thinking);
    parts.push(record.invocation?.sessionPersistence ?? "durable");
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    const toolUses = activity?.toolUses ?? record.toolUses;
    if (toolUses > 0) parts.push(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    return parts.length > 0 ? `  ${theme.fg("dim", parts.join(" · "))}` : "";
  }

  private descriptionPresentation(record: AgentRecord, theme: Theme): string {
    const color = record.status === "queued"
      ? "muted"
      : record.status === "completed" || record.status === "steered"
        ? "success"
        : record.status === "error"
          ? "error"
          : record.status === "running"
            ? "text"
            : "dim";
    return theme.bold(theme.fg(color, record.description));
  }
}
