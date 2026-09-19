import React, { useEffect, useState } from "react";
import { Card, Input, Button, Space, Alert, Descriptions } from "antd";

export default function PluginsPage({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [test, setTest] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.daw.readConfig().then((r) => setText(r.text ?? ""));
  }, []);

  const save = async () => {
    setSaving(true);
    await window.daw.saveConfig(text);
    setSaving(false);
    onSaved();
  };

  const runTest = async () => {
    setTest((await window.daw.testConfig()).results);
  };

  return (
    <Card title="插件与数据源(config.yaml)">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="数据源与模型都在工作区 config.yaml 中配置(文件即权威源)。密钥建议用 auth_token_env 指向环境变量。未配置 StarRocks 时默认启用 mock 演示数据(结果会明确标注);设 starrocks.mock: false 可关闭,配置 host 后自动切真实数据。"
      />
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={16}
        style={{ fontFamily: "monospace", fontSize: 12 }}
        placeholder={`name: 我的工作台\nmodel:\n  base_url: https://api.deepseek.com/anthropic\n  auth_token_env: DEEPSEEK_API_KEY\n  model: deepseek-flash[1m]\nstarrocks:\n  host: ...\n  port: 9030\n  user: ro_user\n  password: ...`}
      />
      <Space style={{ marginTop: 12 }}>
        <Button type="primary" loading={saving} onClick={save}>保存并重载工作区</Button>
        <Button onClick={runTest}>连接测试</Button>
      </Space>
      {test && (
        <Descriptions style={{ marginTop: 16 }} size="small" bordered column={1}>
          {Object.entries(test).map(([k, v]) => (
            <Descriptions.Item key={k} label={k}>
              {String(v)}
            </Descriptions.Item>
          ))}
        </Descriptions>
      )}
    </Card>
  );
}
