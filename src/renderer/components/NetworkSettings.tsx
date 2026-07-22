import { RefreshCw, RotateCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { IpIdentity, NetworkNode, NetworkSettings as NetworkSettingsData } from "../../shared/ipc.js";
import { ProgressBar } from "./ProgressBar.js";

interface NetworkSettingsProps { readonly initial: NetworkSettingsData; readonly onSaved: (settings: NetworkSettingsData) => void; readonly onMessage: (message: string) => void; }
type NetworkBusyKey = "save" | "detect" | "rotate" | "import" | "nodes";

export function NetworkSettingsPanel(props: NetworkSettingsProps) {
  const [form, setForm] = useState({ ...props.initial, secret: "" });
  const [identity, setIdentity] = useState<IpIdentity>();
  const [importText, setImportText] = useState("");
  // Members of the currently selected proxy group, fetched live from the controller (or, for a
  // group just discovered by import and never fetched yet, the flat name list from that import).
  const [groupNodes, setGroupNodes] = useState<readonly NetworkNode[]>([]);
  const [busy, setBusy] = useState<NetworkBusyKey>();
  useEffect(() => setForm({ ...props.initial, secret: "" }), [props.initial]);

  async function save(): Promise<void> {
    setBusy("save");
    try {
      // `form` carries read-only fields (`secretConfigured`, `updatedAt`) inherited from
      // the loaded NetworkSettings; the strict IPC schema only accepts the editable subset.
      const { secretConfigured: _secretConfigured, updatedAt: _updatedAt, ...payload } = form;
      const saved = await window.eplusApi.saveNetworkSettings(payload);
      props.onSaved(saved);
      setForm({ ...saved, secret: "" });
      props.onMessage("网络设置已保存。");
    } catch (error) {
      props.onMessage(`网络设置保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(undefined);
    }
  }
  async function detect(): Promise<void> { setBusy("detect"); try { setIdentity(await window.eplusApi.detectIp()); } catch (error) { props.onMessage(`检测 IP 失败：${error instanceof Error ? error.message : String(error)}`); } finally { setBusy(undefined); } }
  async function rotate(): Promise<void> { setBusy("rotate"); try { await window.eplusApi.rotateIp(); await detect(); await loadGroupNodes(form.proxyGroup); props.onMessage("已请求切换 IP。"); } catch (error) { props.onMessage(`切换 IP 失败：${error instanceof Error ? error.message : String(error)}`); } finally { setBusy(undefined); } }
  async function loadGroupNodes(group: string): Promise<void> {
    if (!group.trim()) return;
    setBusy("nodes");
    try {
      const fetched = await window.eplusApi.listNetworkNodes(group);
      setGroupNodes(fetched);
    } catch (error) {
      props.onMessage(`读取线路失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(undefined);
    }
  }
  function switchGroup(group: string): void {
    setForm({ ...form, proxyGroup: group });
    setGroupNodes([]);
    void loadGroupNodes(group);
  }
  async function importConfig(): Promise<void> {
    setBusy("import");
    try {
      const imported = await window.eplusApi.importNetworkConfig({ controller: form.controller === "direct" ? "clash" : form.controller, text: importText });
      const mergedGroups = Array.from(new Set([...(form.proxyGroups ?? []), ...(imported.proxyGroups ?? [])]));
      setForm((current) => ({ ...current, host: imported.host, port: imported.port, secret: imported.secret ?? "", proxyGroup: imported.proxyGroup, proxyGroups: mergedGroups }));
      // Until a live read confirms this group's real members, show the flat import list as a
      // starting point so there is something to select from before the first save.
      setGroupNodes(imported.availableNodes.map((name) => ({ name, type: "proxy", alive: true })));
      props.onMessage("已解析控制器配置，请选择要使用的分组并勾选节点后保存。");
    } catch (error) {
      props.onMessage(`网络配置解析失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(undefined);
    }
  }
  function toggleNode(name: string): void {
    setForm((current) => {
      const group = current.proxyGroup;
      // Nothing is pre-selected for a group until the user deliberately checks a node — an
      // empty/absent selection means "no restriction, rotate the full group" (see
      // settingsService.getClashConfig), so leaving every box unchecked is a safe, valid default.
      const selected = new Set(current.nodeSelectionsByGroup?.[group] ?? []);
      if (selected.has(name)) selected.delete(name); else selected.add(name);
      return { ...current, nodeSelectionsByGroup: { ...current.nodeSelectionsByGroup, [group]: [...selected] } };
    });
  }
  const groups = form.proxyGroups ?? [];
  const isDirect = form.controller === "direct";
  const selectedSet = new Set(form.nodeSelectionsByGroup?.[form.proxyGroup] ?? []);
  return <section className="workspace-panel" aria-labelledby="network-title"><div className="workspace-heading"><div><p className="section-kicker">设置</p><h1 id="network-title">网络设置</h1><p>{isDirect ? "本机网络已在目标地区，直接校验出口 IP，不经过代理。" : "每个账号开始前轮换一次代理，并在浏览器会话内持续校验出口 IP。"}</p></div></div>
    <section className="panel-card">
      <div className="panel-head"><h2><ShieldCheck size={16} />代理控制器</h2><span className="muted">Clash Verge 与 sing-box 均使用兼容的 Clash API</span></div>
      <div className="form-grid">
        <label>控制器类型<select value={form.controller} onChange={(event) => setForm({ ...form, controller: event.target.value as "clash" | "sing-box" | "direct" })}><option value="clash">Clash Verge / Clash</option><option value="sing-box">sing-box Clash API</option><option value="direct">直连（本机网络已在日本，无需代理）</option></select></label>
        {isDirect ? null : <>
          <label>控制器主机<input value={form.host} placeholder="例如：127.0.0.1" onChange={(event) => setForm({ ...form, host: event.target.value })} /></label>
          <label>控制器端口<input type="number" min="1" value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></label>
          <label>控制器密钥<input type="password" value={form.secret} placeholder={form.secretConfigured ? "已保存，留空则不变" : "切换 IP 需要密钥"} onChange={(event) => setForm({ ...form, secret: event.target.value })} /></label>
        </>}
        <label>要求国家<input value={form.requiredCountry} placeholder="例如：Japan" onChange={(event) => setForm({ ...form, requiredCountry: event.target.value })} /></label>
        <label>网络策略<input value={form.policy} onChange={(event) => setForm({ ...form, policy: event.target.value })} /></label>
      </div>
      {isDirect ? <p className="muted">直连模式下不会启动 Clash/sing-box 轮换；每次运行前仍会校验当前出口 IP 是否符合“要求国家”。</p> : null}
    </section>
    {isDirect ? null : <section className="panel-card">
      <div className="panel-head"><h2><ShieldCheck size={16} />分组与节点</h2><span className="muted">可保存多个分组，随时切换使用哪一个</span></div>
      <div className="form-grid">
        <label>当前分组{groups.length ? <select value={form.proxyGroup} onChange={(event) => switchGroup(event.target.value)}>{groups.map((group) => <option key={group} value={group}>{group}</option>)}</select> : <input value={form.proxyGroup} placeholder="例如：Auto" onChange={(event) => setForm({ ...form, proxyGroup: event.target.value })} />}</label>
      </div>
      <div className="actions"><button type="button" className="icon-button" disabled={!form.proxyGroup.trim() || busy === "nodes"} onClick={() => { void loadGroupNodes(form.proxyGroup); }}>{busy === "nodes" ? "正在读取" : "读取线路"}</button></div>
      {groupNodes.length > 0 ? <div className="node-checklist" aria-label="选择保存进当前分组的节点">
        <div className="panel-head subsection-head"><h3>「{form.proxyGroup}」节点（{selectedSet.size} / {groupNodes.length} 已选）</h3><span className="muted">勾选要保留的节点；全部不勾选则使用该分组的全部节点</span></div>
        <div className="node-checklist-grid">{groupNodes.map((node) => <label key={node.name} className="check-row"><input type="checkbox" checked={selectedSet.has(node.name)} onChange={() => toggleNode(node.name)} /><span>{node.name}</span>{node.delay === undefined ? null : <small>{node.alive ? `${node.delay} ms` : "不可用"}</small>}</label>)}</div>
      </div> : <p className="empty-state">尚未读取该分组的节点，点击“读取线路”或先导入代理配置。</p>}
      <details className="import-config">
        <summary>导入代理配置（仅用于首次获取主机、密钥和分组列表）</summary>
        <label className="wide-field">粘贴 Clash Verge / sing-box 配置<textarea rows={5} value={importText} placeholder="粘贴 YAML 或 JSON；仅解析 external-controller、secret、分组和节点列表" onChange={(event) => setImportText(event.target.value)} /></label>
        <div className="actions"><button type="button" className="icon-button" disabled={!importText.trim() || busy === "import"} onClick={() => { void importConfig(); }}>{busy === "import" ? "正在解析" : "解析并填入"}</button></div>
      </details>
    </section>}
    <section className="panel-card">
      <div className="network-identity">{busy === "detect" || busy === "rotate" ? <ProgressBar compact label={busy === "rotate" ? "正在切换 IP" : "正在检测出口 IP"} /> : identity ? <span>{identity.ip} · {identity.country}, {identity.region}{identity.city ? `, ${identity.city}` : ""}</span> : <span className="muted">尚未检测出口 IP。</span>}<span className="privacy-note">IP 查询会发送至第三方服务 ip-api.com。{isDirect ? "" : "轮换会调用本机控制器，不会把密钥写入日志。"}</span></div>
      <div className="actions"><button type="button" className="icon-button" disabled={busy === "detect"} onClick={() => { void detect(); }}><RefreshCw size={16} />{busy === "detect" ? "正在检测" : "检测 IP"}</button>{isDirect ? null : <button type="button" className="icon-button" disabled={(!form.secretConfigured && !form.secret) || busy === "rotate"} onClick={() => { void rotate(); }}><RotateCw size={16} />{busy === "rotate" ? "正在切换" : "切换 IP"}</button>}<button type="button" className="primary" disabled={busy === "save"} onClick={() => { void save(); }}><ShieldCheck size={16} />{busy === "save" ? "正在保存" : "保存网络设置"}</button></div>
    </section>
  </section>;
}
