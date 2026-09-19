import React, { useEffect, useState } from "react";
import { Card, Tabs, Table, Input, Tag, Button, Space, message, Popconfirm, Collapse, List } from "antd";
import { DownloadOutlined, AppstoreOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";

interface MetricRow {
  metricName: string; displayName: string; type: string; unit?: string;
  businessCaliber?: string; datasetName?: string; physicalTables: string[];
  dimensions: string[]; categoryPath: string[];
}
interface DatasetRow { datasetName: string; displayName?: string; physicalTables: string[]; metrics: string[]; columns: string[] }
interface GlossaryRow { term: string; synonyms: string[]; metricRefs?: string[]; note?: string }

interface MdItem { name: string; content: string }

export default function SemanticsPage({ role }: { role?: string }) {
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [datasets, setDatasets] = useState<DatasetRow[]>([]);
  const [glossary, setGlossary] = useState<GlossaryRow[]>([]);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [entitiesYaml, setEntitiesYaml] = useState("");
  const [knowledge, setKnowledge] = useState<MdItem[]>([]);
  const [playbooks, setPlaybooks] = useState<MdItem[]>([]);

  const canEdit = role === "admin" || role === "engineer";

  const reload = () => {
    window.daw.listSemantics("metrics").then((r) => setMetrics(r.items as MetricRow[]));
    window.daw.listSemantics("datasets").then((r) => setDatasets(r.items as DatasetRow[]));
    window.daw.listSemantics("glossary").then((r) => setGlossary(r.items as GlossaryRow[]));
    window.daw.readEntities().then((r) => setEntitiesYaml(r.text ?? ""));
    window.daw.listKnowledge().then(setKnowledge);
    window.daw.listPlaybooks().then(setPlaybooks);
  };
  useEffect(reload, []);

  const saveGlossary = async () => {
    setSaving(true);
    const lines = ["terms:"];
    for (const g of glossary) {
      lines.push(`  - term: ${JSON.stringify(g.term)}`);
      lines.push(`    synonyms: [${g.synonyms.map((x) => JSON.stringify(x)).join(", ")}]`);
      if (g.metricRefs && g.metricRefs.length > 0) {
        lines.push(`    metricRefs: [${g.metricRefs.map((x) => JSON.stringify(x)).join(", ")}]`);
      }
    }
    const r = await window.daw.saveGlossary(lines.join("\n") + "\n");
    setSaving(false);
    if (r.ok) {
      message.success("术语已保存,检索即时生效");
      setDirty(false);
    } else message.error(r.error ?? "保存失败");
  };

  const importDir = async () => {
    const r = await window.daw.importSemantics();
    if (r.ok) {
      message.success(`已导入 ${r.copied} 个文件,语义资产已刷新`);
      reload();
    } else if (r.error !== "cancel") message.error(r.error ?? "导入失败");
  };

  const loadDemo = async () => {
    const r = await window.daw.loadDemoSemantics();
    if (r.ok) {
      message.success(`已载入演示语义包(${r.copied} 个文件,390 指标)`);
      reload();
    } else message.error(r.error ?? "载入失败");
  };

  const filtered = (list: MetricRow[]) =>
    !q.trim() ? list : list.filter(
      (m) => m.metricName.includes(q) || m.displayName.includes(q) || (m.businessCaliber ?? "").includes(q),
    );

  const glossaryCols = [
    {
      title: "术语", dataIndex: "term", width: 180,
      render: (_v: unknown, r: GlossaryRow) => canEdit
        ? <Input value={r.term} size="small" onChange={(e) => upd(r, { term: e.target.value })} />
        : r.term,
    },
    {
      title: "同义词(逗号分隔)", dataIndex: "synonyms",
      render: (_v: unknown, r: GlossaryRow) => canEdit
        ? <Input value={r.synonyms.join(", ")} size="small" onChange={(e) => upd(r, { synonyms: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) })} />
        : r.synonyms.join(" / "),
    },
    {
      title: "关联指标(逗号分隔)", dataIndex: "metricRefs", width: 320,
      render: (_v: unknown, r: GlossaryRow) => canEdit
        ? <Input value={(r.metricRefs ?? []).join(", ")} size="small" onChange={(e) => upd(r, { metricRefs: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) })} />
        : (r.metricRefs ?? []).join(", "),
    },
    ...(canEdit
      ? [{
          title: "", width: 60,
          render: (_v: unknown, r: GlossaryRow) => (
            <Popconfirm title="删除该术语?" onConfirm={() => setGlossary(glossary.filter((x) => x !== r))}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          ),
        }]
      : []),
  ];
  const upd = (row: GlossaryRow, patch: Partial<GlossaryRow>) => {
    setGlossary(glossary.map((g) => (g === row ? { ...g, ...patch } : g)));
    setDirty(true);
  };

  return (
    <div className="daw-card">
      <Space style={{ marginBottom: 12 }}>
        <Input.Search placeholder="过滤指标(名称/口径)" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 320 }} />
        {canEdit && <Button icon={<DownloadOutlined />} onClick={importDir}>导入北斗导出目录…</Button>}
        {canEdit && <Button icon={<AppstoreOutlined />} onClick={loadDemo}>载入演示语义包</Button>}
      </Space>
      <Tabs
        items={[
          {
            key: "metrics",
            label: `指标(${metrics.length})`,
            children: (
              <Table<MetricRow>
                size="small" rowKey="metricName" dataSource={filtered(metrics)} pagination={{ pageSize: 15 }}
                columns={[
                  { title: "指标", dataIndex: "displayName", width: 180 },
                  { title: "metricName", dataIndex: "metricName", width: 240, ellipsis: true },
                  { title: "类型", dataIndex: "type", width: 100, render: (t) => <Tag>{t}</Tag> },
                  { title: "业务口径", dataIndex: "businessCaliber", ellipsis: true },
                  { title: "数据集", dataIndex: "datasetName", width: 200, ellipsis: true },
                  { title: "维度数", width: 70, render: (_v, r) => r.dimensions.length },
                ]}
              />
            ),
          },
          {
            key: "datasets",
            label: `数据集(${datasets.length})`,
            children: (
              <Table<DatasetRow>
                size="small" rowKey="datasetName" dataSource={datasets} pagination={{ pageSize: 15 }}
                columns={[
                  { title: "数据集", dataIndex: "displayName", width: 200 },
                  { title: "datasetName", dataIndex: "datasetName", width: 240, ellipsis: true },
                  { title: "物理表", dataIndex: "physicalTables", render: (v: string[]) => v.join(", "), ellipsis: true },
                  { title: "指标数", width: 80, render: (_v, r) => r.metrics.length },
                  { title: "列数", width: 70, render: (_v, r) => r.columns.length },
                ]}
              />
            ),
          },
          {
            key: "glossary",
            label: (
              <Space size={4}>
                术语({glossary.length})
                {canEdit && (
                  <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => { setGlossary([...glossary, { term: "", synonyms: [] }]); setDirty(true); }} />
                )}
              </Space>
            ),
            children: (
              <>
                <Table<GlossaryRow> size="small" rowKey={(r) => r.term + glossary.indexOf(r)} dataSource={glossary} pagination={false} columns={glossaryCols} />
                {canEdit && (
                  <Button type="primary" style={{ marginTop: 12 }} loading={saving} disabled={!dirty} onClick={saveGlossary}>
                    保存术语(glossary.yaml)
                  </Button>
                )}
              </>
            ),
          },
          {
            key: "entities",
            label: "实体与业务模型",
            children: (
              <>
                <Input.TextArea
                  value={entitiesYaml}
                  onChange={(e) => { setEntitiesYaml(e.target.value); setDirty(true); }}
                  disabled={!canEdit}
                  rows={18}
                  style={{ fontFamily: "monospace", fontSize: 12 }}
                />
                {canEdit && (
                  <Button type="primary" style={{ marginTop: 12 }} onClick={async () => {
                    const r = await window.daw.saveEntities(entitiesYaml);
                    if (r.ok) message.success("实体与业务模型已保存");
                    else message.error(r.error ?? "保存失败");
                    reload();
                  }}>保存 entities.yaml</Button>
                )}
              </>
            ),
          },
          {
            key: "knowledge",
            label: `业务知识库(${knowledge.length})`,
            children: (
              <Collapse
                items={knowledge.map((k) => ({
                  key: k.name,
                  label: <Tag color="cyan">{k.name}</Tag>,
                  children: (
                    <MdEditor
                      initial={k}
                      canEdit={canEdit}
                      onSave={async (name, content) => window.daw.saveKnowledge(name, content)}
                      onSaved={reload}
                    />
                  ),
                }))}
              />
            ),
          },
          {
            key: "playbooks",
            label: `业务 Playbook(${playbooks.length})`,
            children: (
              <Collapse
                items={playbooks.map((k) => ({
                  key: k.name,
                  label: <Tag color="geekblue">{k.name}</Tag>,
                  children: (
                    <MdEditor
                      initial={k}
                      canEdit={canEdit}
                      onSave={async (name, content) => window.daw.savePlaybook(name, content)}
                      onSaved={reload}
                    />
                  ),
                }))}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

function MdEditor({ initial, canEdit, onSave, onSaved }: {
  initial: MdItem;
  canEdit: boolean;
  onSave: (name: string, content: string) => Promise<{ ok: boolean; error?: string }>;
  onSaved: () => void;
}) {
  const [text, setText] = useState(initial.content);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!editing) {
    return (
      <div>
        <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", background: "#fafafa", padding: 12 }}>{text}</pre>
        {canEdit && <Button size="small" onClick={() => setEditing(true)}>编辑</Button>}
      </div>
    );
  }
  return (
    <div>
      <Input.TextArea value={text} onChange={(e) => setText(e.target.value)} rows={14} style={{ fontFamily: "monospace", fontSize: 12 }} />
      <Space style={{ marginTop: 8 }}>
        <Button size="small" type="primary" loading={busy} onClick={async () => {
          setBusy(true);
          const r = await onSave(initial.name, text);
          setBusy(false);
          if (r.ok) { message.success("已保存"); setEditing(false); onSaved(); }
          else message.error(r.error ?? "保存失败");
        }}>保存</Button>
        <Button size="small" onClick={() => { setText(initial.content); setEditing(false); }}>取消</Button>
      </Space>
    </div>
  );
}
