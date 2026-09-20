import React, { useEffect, useState } from "react";
import { Card, Descriptions, Alert, List, Typography, Tabs, Input, Button, message, Space, Tag } from "antd";

interface WsState {
  ok: boolean;
  dir?: string;
  name?: string;
  warnings?: string[];
  counts?: Record<string, number>;
  identity?: { username: string; name?: string; expired?: boolean } | null;
  role?: string;
}

export default function SettingsPage({ ws, onRefresh }: { ws: WsState | null; onRefresh: () => void }) {
  const [membersText, setMembersText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.daw.readMembers().then((r) => setMembersText(r.text ?? ""));
  }, [ws?.dir]);

  const isAdmin = ws?.role === "admin";

  const saveMembers = async () => {
    setSaving(true);
    const r = await window.daw.saveMembers(membersText);
    setSaving(false);
    if (r.ok) message.success("成员已保存,权限即时生效");
    else message.error(r.error ?? "保存失败");
    onRefresh();
  };

  return (
    <Card>
      <Tabs
        items={[
          {
            key: "space",
            label: "空间",
            children: (
              <>
                <Descriptions bordered column={1} size="small">
                  <Descriptions.Item label="空间目录">{ws?.dir ?? "-"}</Descriptions.Item>
                  <Descriptions.Item label="当前用户">
                    {ws?.identity ? `${ws.identity.name ?? ""}(${ws.identity.username})` : "未登录(按 viewer)"} · 角色 {ws?.role ?? "-"}
                  </Descriptions.Item>
                  <Descriptions.Item label="资产统计">
                    指标 {ws?.counts?.metrics ?? 0} / 数据集 {ws?.counts?.datasets ?? 0} / 术语 {ws?.counts?.glossary ?? 0} /
                    物理表 {ws?.counts?.physicalTables ?? 0} / 列绑定 {ws?.counts?.columnBindings ?? 0}
                  </Descriptions.Item>
                </Descriptions>
                {(ws?.warnings?.length ?? 0) > 0 && (
                  <Alert
                    type="warning"
                    style={{ marginTop: 12 }}
                    message="装载警告"
                    description={
                      <List
                        size="small"
                        dataSource={ws!.warnings!}
                        renderItem={(w) => <List.Item style={{ fontSize: 12 }}>{w}</List.Item>}
                      />
                    }
                  />
                )}
                <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
                  空间即目录:资产在 semantics/ 下、技能在 .claude/skills/、成员在 members.yaml、隔离范围在 semantics/scope.yaml。
                  多空间通过右上角空间菜单切换/新建/导入;全部可纳入 Git 管理。
                </Typography.Paragraph>
              </>
            ),
          },
          {
            key: "members",
            label: "成员与角色",
            children: (
              <>
                <Alert
                  type={isAdmin ? "info" : "warning"}
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={
                    isAdmin
                      ? "角色权限:admin=全部;engineer=对话/语义编辑/技能;analyst=对话/语义查看;viewer=仅对话。菜单与操作双层校验。"
                      : "仅空间管理员(admin)可编辑成员;你当前为只读视图。"
                  }
                />
                <Input.TextArea
                  value={membersText}
                  onChange={(e) => setMembersText(e.target.value)}
                  disabled={!isAdmin}
                  rows={12}
                  style={{ fontFamily: "monospace", fontSize: 12 }}
                />
                <Button type="primary" style={{ marginTop: 12 }} disabled={!isAdmin} loading={saving} onClick={saveMembers}>
                  保存成员
                </Button>
              </>
            ),
          },
          {
            key: "model",
            label: "模型",
            children: <ModelTab ws={ws} onRefresh={onRefresh} />,
          },
          {
            key: "import",
            label: "语义资产导入",
            children: (
              <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
                把北斗导出的 metrics.json / details.json / dimensions.json / tree.json /
                lineage_summary.json / physical_tables.json 放入空间目录的 semantics/import/,刷新即可。
                术语在 semantics/glossary.yaml 维护;空间隔离范围在 semantics/scope.yaml
                (支持 metricNames / categoryPaths / datasets / tables,并集生效;不配置=空间可见导入全集)。
              </Typography.Paragraph>
            ),
          },
        ]}
      />
    </Card>
  );
}

/** 模型配置(dsh-desktop 式):结构化表单,密钥只写不读 */
function ModelTab({ ws, onRefresh }: { ws: WsState | null; onRefresh: () => void }) {
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/anthropic");
  const [model, setModel] = useState("deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<{ keyConfigured?: boolean; keySource?: "auth_token" | "env" | "none"; envVar?: string | null }>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const isAdmin = ws?.role === "admin";

  useEffect(() => {
    void window.daw.modelRead().then((r) => {
      if (!r.ok) return;
      setBaseUrl(r.baseUrl ?? "https://api.deepseek.com/anthropic");
      setModel(r.model ?? "deepseek-chat");
      setState({ keyConfigured: r.keyConfigured, keySource: r.keySource, envVar: r.envVar });
    });
  }, [ws?.dir]);

  const save = async () => {
    setSaving(true);
    const r = await window.daw.modelSave({ baseUrl, model, apiKey });
    setSaving(false);
    if (r.ok) {
      message.success("模型配置已保存,即时生效");
      setApiKey("");
      const rd = await window.daw.modelRead();
      setState({ keyConfigured: rd.keyConfigured, keySource: rd.keySource, envVar: rd.envVar });
      onRefresh();
    } else {
      message.error(r.error ?? "保存失败");
    }
  };

  const test = async () => {
    setTesting(true);
    const r = await window.daw.modelTest();
    setTesting(false);
    setTestResult(r);
  };

  return (
    <>
      <Alert
        type={state.keyConfigured ? "success" : "warning"}
        showIcon
        style={{ marginBottom: 12 }}
        message={
          state.keyConfigured
            ? `API Key 已配置(${state.keySource === "auth_token" ? "保存于本空间 config.yaml" : `经环境变量 ${state.envVar}`})`
            : "未配置 API Key——当前为演示模式,回答由固定管线生成"
        }
      />
      <div style={{ display: "grid", gap: 10, maxWidth: 560 }}>
        <label style={{ fontSize: 12 }}>
          Base URL(Anthropic 兼容端点)
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={!isAdmin} style={{ marginTop: 4 }} placeholder="https://api.deepseek.com/anthropic" />
        </label>
        <label style={{ fontSize: 12 }}>
          模型名
          <Input value={model} onChange={(e) => setModel(e.target.value)} disabled={!isAdmin} style={{ marginTop: 4 }} placeholder="deepseek-chat" />
        </label>
        <label style={{ fontSize: 12 }}>
          API Key
          <Input.Password
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={!isAdmin}
            style={{ marginTop: 4 }}
            placeholder={state.keyConfigured ? "已配置——留空保持不变,输入则替换" : "sk-..."}
          />
        </label>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          Key 只写不读:保存到本空间 config.yaml 的 model.auth_token(优先于环境变量),不进 Git。
          安装版从 Finder/Dock 启动时读不到 shell 环境变量,推荐直接在此填 Key。
        </Typography.Paragraph>
        <Space>
          <Button type="primary" disabled={!isAdmin} loading={saving} onClick={save}>保存配置</Button>
          <Button loading={testing} onClick={test}>测试连接</Button>
          {testResult && (
            <Tag color={testResult.ok ? "success" : "error"} style={{ fontSize: 12 }}>
              {testResult.message}
            </Tag>
          )}
        </Space>
      </div>
    </>
  );
}
