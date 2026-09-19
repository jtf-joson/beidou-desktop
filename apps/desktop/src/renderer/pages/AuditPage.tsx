import React, { useEffect, useState } from "react";
import { Card, Table, Tag } from "antd";

interface AuditRow {
  ts: string;
  kind: string;
  sessionId: string;
  summary: string;
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => {
    window.daw.auditTail(300).then((r) => setRows(r as AuditRow[]));
    const t = setInterval(() => window.daw.auditTail(300).then((r) => setRows(r as AuditRow[])), 5000);
    return () => clearInterval(t);
  }, []);

  const color = (k: string) =>
    k === "guard_rejection" ? "red" : k === "agent_reply" ? "green" : k === "user_message" ? "blue" : "default";

  return (
    <div className="daw-card">
      <div className="daw-side-title" style={{ marginBottom: 12 }}>审计日志(最近 {rows.length} 条,JSONL 只追加)</div>
      <Table<AuditRow>
        size="small"
        rowKey={(r) => `${r.ts}-${r.summary}`}
        dataSource={[...rows].reverse()}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: "时间", dataIndex: "ts", width: 210 },
          { title: "类型", dataIndex: "kind", width: 130, render: (k) => <Tag color={color(k)}>{k}</Tag> },
          { title: "会话", dataIndex: "sessionId", width: 130, ellipsis: true },
          { title: "摘要", dataIndex: "summary", ellipsis: true },
        ]}
      />
    </div>
  );
}
