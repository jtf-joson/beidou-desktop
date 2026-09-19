import React, { useEffect, useState } from "react";
import { Card, Collapse, Tag, Empty, Typography, Switch, Input, Button, Space, Modal, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";

interface SkillItem { name: string; content: string; enabled: boolean }

export default function SkillsPage({ role }: { role?: string }) {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [editing, setEditing] = useState<{ name: string; content: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const canManage = role === "admin" || role === "engineer";

  const reload = () => {
    window.daw.listSkills().then((r) => setSkills(r.skills));
  };
  useEffect(reload, []);

  const toggle = async (name: string, enabled: boolean) => {
    const r = await window.daw.toggleSkill(name, enabled);
    if (r.ok) {
      message.success(`${name} 已${enabled ? "启用" : "停用"}(下个会话生效)`);
      reload();
    } else message.error(r.error ?? "操作失败");
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const r = await window.daw.saveSkill(editing.name, editing.content);
    setSaving(false);
    if (r.ok) {
      message.success("技能已保存");
      setEditing(null);
      reload();
    } else message.error(r.error ?? "保存失败");
  };

  if (skills.length === 0 && !canManage) {
    return <div className="daw-card"><Empty description="工作区无技能" /></div>;
  }

  return (
    <div className="daw-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span className="daw-side-title">技能({skills.filter((s) => s.enabled).length}/{skills.length} 启用)—— Agent SDK 从工作区自动加载</span>
        {canManage ? <Button size="small" icon={<PlusOutlined />} onClick={() => { setCreating(true); setEditing({ name: "", content: "---\nname: my-skill\ndescription: 描述何时触发本技能。\n---\n\n# SOP\n1. …\n" }); }}>新建技能</Button> : null}
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        技能即文件(SKILL.md):与 system prompt 路由协议协同约束 Agent 行为;停用 = 目录改名 .disabled(不删数据)。
      </Typography.Paragraph>
      <Collapse
        items={skills.map((s) => ({
          key: s.name,
          label: (
            <Space>
              <Tag color={s.enabled ? "purple" : "default"}>{s.name}</Tag>
              {canManage && <Switch size="small" checked={s.enabled} onChange={(v) => toggle(s.name, v)} />}
              {canManage && (
                <Button size="small" type="link" onClick={(e) => { e.stopPropagation(); setEditing({ name: s.name, content: s.content }); }}>编辑</Button>
              )}
            </Space>
          ),
          children: (
            <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", background: "#fafafa", padding: 12 }}>{s.content}</pre>
          ),
        }))}
      />
      <Modal
        open={editing !== null}
        title={creating ? "新建技能" : `编辑技能:${editing?.name}`}
        width={720}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={save}
        onCancel={() => setEditing(null)}
      >
        {creating && (
          <Input
            placeholder="技能目录名(英文/数字/-)"
            value={editing?.name ?? ""}
            onChange={(e) => setEditing(editing ? { ...editing, name: e.target.value } : editing)}
            style={{ marginBottom: 8 }}
          />
        )}
        <Input.TextArea
          value={editing?.content ?? ""}
          onChange={(e) => setEditing(editing ? { ...editing, content: e.target.value } : editing)}
          rows={18}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />
      </Modal>
    </div>
  );
}
