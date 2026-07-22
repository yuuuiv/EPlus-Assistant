import { RefreshCw, RotateCw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { IpIdentity, NetworkNode, NetworkSettings as NetworkSettingsData } from "../../shared/ipc.js";
import { ProgressBar } from "./ProgressBar.js";

interface NetworkSettingsProps { readonly initial: NetworkSettingsData; readonly onSaved: (settings: NetworkSettingsData) => void; readonly onMessage: (message: string) => void; }
type NetworkBusyKey = "save" | "detect" | "rotate" | "import" | "nodes";

function activeNodes(settings: NetworkSettingsData): string[] {
  return settings.nodeSubsetPresets?.find((preset) => preset.name === settings.activeNodeSubsetPresetName)?.nodes ?? [];
}

export function NetworkSettingsPanel(props: NetworkSettingsProps) {
  const [form, setForm] = useState({ ...props.initial, secret: "" });
  const [identity, setIdentity] = useState<IpIdentity>();
  const [importText, setImportText] = useState("");
  // Members of the auto-resolved proxy group, fetched live from the controller (or, right after
  // an import and before the first live read, the flat name list found in the pasted config).
  const [groupNodes, setGroupNodes] = useState<readonly NetworkNode[]>([]);
  const [checkedNodes, setCheckedNodes] = useState<Set<string>>(() => new Set(activeNodes(props.initial)));
  const [presetName, setPresetName] = useState(props.initial.activeNodeSubsetPresetName ?? "");
  const [busy, setBusy] = useState<NetworkBusyKey>();
  useEffect(() => {
    setForm({ ...props.initial, secret: "" });
    setCheckedNodes(new Set(activeNodes(props.initial)));
    setPresetName(props.initial.activeNodeSubsetPresetName ?? "");
  }, [props.initial]);

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
  async function rotate(): Promise<void> { setBusy("rotate"); try { await window.eplusApi.rotateIp(); await detect(); await loadGroupNodes(); props.onMessage("已请求切换 IP。"); } catch (error) { props.onMessage(`切换 IP 失败：${error instanceof Error ? error.message : String(error)}`); } finally { setBusy(undefined); } }
  async function loadGroupNodes(): Promise<void> {
    setBusy("nodes");
    try {
      // The main process resolves which real Clash proxy-group to use on its own; the renderer
      // never names or picks it.
      setGroupNodes(await window.eplusApi.listNetworkNodes());
    } catch (error) {
      props.onMessage(`读取线路失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(undefined);
    }
  }
  async function importConfig(): Promise<void> {
    setBusy("import");
    try {
      const imported = await window.eplusApi.importNetworkConfig({ controller: form.controller === "direct" ? "clash" : form.controller, text: importText });
      setForm((current) => ({ ...current, host: imported.host, port: imported.port, secret: imported.secret ?? "" }));
      setGroupNodes(imported.availableNodes.map((name) => ({ name, type: "proxy", alive: true })));
      props.onMessage("已解析主机、端口和密钥；保存或检测 IP 时程序会自动确认要使用的代理分组。");
    } catch (error) {
      props.onMessage(`网络配置解析失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(undefined);
    }
  }
  function toggleNode(name: string): void {
    setCheckedNodes((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }
  function selectPreset(name: string): void {
    setPresetName(name);
    setCheckedNodes(new Set(form.nodeSubsetPresets?.find((preset) => preset.name === name)?.nodes ?? []));
    setForm((current) => ({ ...current, activeNodeSubsetPresetName: name || undefined }));
  }
  function savePreset(): void {
    const name = presetName.trim();
    if (!name) { props.onMessage("请先给节点子集方案起一个名字。"); return; }
    const nodes = [...checkedNodes];
    const presets = form.nodeSubsetPresets ?? [];
    const next = [...presets.filter((preset) => preset.name !== name), { name, nodes }];
    setForm((current) => ({ ...current, nodeSubsetPresets: next, activeNodeSubsetPresetName: name }));
    props.onMessage(`方案「${name}」已更新，记得点击“保存网络设置”写入磁盘。`);
  }
  function deletePreset(): void {
    const name = form.activeNodeSubsetPresetName;
    if (!name) return;
    setForm((current) => ({ ...current, nodeSubsetPresets: (current.nodeSubsetPresets ?? []).filter((preset) => preset.name !== name), activeNodeSubsetPresetName: undefined }));
    setCheckedNodes(new Set());
    setPresetName("");
  }

  const isDirect = form.controller === "direct";
  const presets = form.nodeSubsetPresets ?? [];
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
      <div className="panel-head"><h2><ShieldCheck size={16} />节点方案</h2><span className="muted">实际使用哪个 Clash 分组由程序自动确定；这里保存的是你自己命名的节点子集方案，可随时切换</span></div>
      <div className="form-grid">
        <label>当前方案{presets.length ? <select value={form.activeNodeSubsetPresetName ?? ""} onChange={(event) => selectPreset(event.target.value)}><option value="">（未选择，使用全部节点）</option>{presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}（{preset.nodes.length}）</option>)}</select> : <span className="muted">尚未保存任何方案</span>}</label>
      </div>
      <div className="actions"><button type="button" className="icon-button" disabled={busy === "nodes"} onClick={() => { void loadGroupNodes(); }}>{busy === "nodes" ? "正在读取" : "读取线路"}</button></div>
      {groupNodes.length > 0 ? <div className="node-checklist" aria-label="选择要纳入方案的节点">
        <div className="panel-head subsection-head"><h3>节点列表（{checkedNodes.size} / {groupNodes.length} 已选）</h3><span className="muted">勾选要保留的节点；全部不勾选则使用全部节点</span></div>
        <div className="node-checklist-grid">{groupNodes.map((node) => <label key={node.name} className="check-row"><input type="checkbox" checked={checkedNodes.has(node.name)} onChange={() => toggleNode(node.name)} /><span>{node.name}</span>{node.delay === undefined ? null : <small>{node.alive ? `${node.delay} ms` : "不可用"}</small>}</label>)}</div>
      </div> : <p className="empty-state">尚未读取节点，点击“读取线路”或先导入代理配置。</p>}
      <div className="form-grid">
        <label>方案名称<input value={presetName} placeholder="例如：日本优先" onChange={(event) => setPresetName(event.target.value)} /></label>
      </div>
      <div className="actions">
        <button type="button" className="icon-button" onClick={savePreset}>保存为方案</button>
        <button type="button" className="icon-button danger" disabled={!form.activeNodeSubsetPresetName} onClick={deletePreset}><Trash2 size={15} />删除当前方案</button>
      </div>
      <details className="import-config">
        <summary>导入代理配置（仅用于首次获取主机、端口和密钥）</summary>
        <label className="wide-field">粘贴 Clash Verge / sing-box 配置<textarea rows={5} value={importText} placeholder="粘贴 YAML 或 JSON；仅解析 external-controller 和 secret" onChange={(event) => setImportText(event.target.value)} /></label>
        <div className="actions"><button type="button" className="icon-button" disabled={!importText.trim() || busy === "import"} onClick={() => { void importConfig(); }}>{busy === "import" ? "正在解析" : "解析并填入"}</button></div>
      </details>
    </section>}
    <section className="panel-card">
      <div className="network-identity">{busy === "detect" || busy === "rotate" ? <ProgressBar compact label={busy === "rotate" ? "正在切换 IP" : "正在检测出口 IP"} /> : identity ? <span>{identity.ip} · {identity.country}, {identity.region}{identity.city ? `, ${identity.city}` : ""}</span> : <span className="muted">尚未检测出口 IP。</span>}<span className="privacy-note">IP 查询会发送至第三方服务 ip-api.com。{isDirect ? "" : "轮换会调用本机控制器，不会把密钥写入日志。"}</span></div>
      <div className="actions"><button type="button" className="icon-button" disabled={busy === "detect"} onClick={() => { void detect(); }}><RefreshCw size={16} />{busy === "detect" ? "正在检测" : "检测 IP"}</button>{isDirect ? null : <button type="button" className="icon-button" disabled={(!form.secretConfigured && !form.secret) || busy === "rotate"} onClick={() => { void rotate(); }}><RotateCw size={16} />{busy === "rotate" ? "正在切换" : "切换 IP"}</button>}<button type="button" className="primary" disabled={busy === "save"} onClick={() => { void save(); }}><ShieldCheck size={16} />{busy === "save" ? "正在保存" : "保存网络设置"}</button></div>
    </section>
  </section>;
}
