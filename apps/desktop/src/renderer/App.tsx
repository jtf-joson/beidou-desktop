import React, { useEffect, useState } from "react";
import { Tooltip, Dropdown, Modal, Input, Avatar, message } from "antd";
import {
  MessageOutlined,
  ApartmentOutlined,
  ThunderboltOutlined,
  ApiOutlined,
  FileSearchOutlined,
  SettingOutlined,
  DownOutlined,
  UserOutlined,
  BulbOutlined,
  MoonOutlined,
  PlusOutlined,
  FolderOpenOutlined,
  DeleteOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { theme as antdTheme } from "antd";
import ChatPage from "./pages/ChatPage";
import SemanticsPage from "./pages/SemanticsPage";
import SkillsPage from "./pages/SkillsPage";
import PluginsPage from "./pages/PluginsPage";
import AuditPage from "./pages/AuditPage";
import SettingsPage from "./pages/SettingsPage";

import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

interface WsState {
  ok: boolean;
  dir?: string;
  name?: string;
  warnings?: string[];
  modelConfigured?: boolean;
  starrocksConfigured?: boolean;
  mockData?: boolean;
  counts?: Record<string, number>;
  identity?: { username: string; name?: string; email?: string; expired?: boolean; source?: string } | null;
  role?: string;
  menus?: string[];
  space?: { id?: string; name?: string; spaces?: Array<{ id: string; name: string; dir: string }> };
}

const PAGE_META: Record<string, { icon: React.ReactNode; title: string }> = {
  chat: { icon: <MessageOutlined />, title: "对话" },
  semantics: { icon: <ApartmentOutlined />, title: "语义资产" },
  skills: { icon: <ThunderboltOutlined />, title: "技能" },
  plugins: { icon: <ApiOutlined />, title: "插件与数据源" },
  audit: { icon: <FileSearchOutlined />, title: "审计" },
  settings: { icon: <SettingOutlined />, title: "设置" },
};

export default function App() {
  const [page, setPage] = useState("chat");
  const [ws, setWs] = useState<WsState | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem("daw.theme") === "dark");
  const [modal, contextHolder] = Modal.useModal();

  const apply = (s: Record<string, unknown>) => setWs(s as unknown as WsState);
  const refresh = () => window.daw.workspaceState().then(apply);
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("daw.theme", dark ? "dark" : "light");
  }, [dark]);

  const menusAllowed = new Set(ws?.menus ?? ["chat"]);
  const railItems = Object.entries(PAGE_META).filter(([key]) => menusAllowed.has(key));

  const newSpace = () => {
    let name = "";
    modal.confirm({
      title: "新建空间",
      content: <Input placeholder="空间名称(如:智驾分析)" onChange={(e) => (name = e.target.value)} />,
      okText: "创建",
      onOk: async () => {
        apply(await window.daw.createSpace(name));
        message.success("空间已创建并切换");
      },
    });
  };

  const spaceMenu = {
    items: [
      ...(ws?.space?.spaces ?? []).map((s) => ({ key: s.id, label: `${s.name}${s.id === ws?.space?.id ? " ✓" : ""}` })),
      { type: "divider" as const },
      { key: "__new", icon: <PlusOutlined />, label: "新建空间…" },
      { key: "__import", icon: <FolderOpenOutlined />, label: "导入已有空间目录…" },
      ...(ws?.role === "admin" && (ws?.space?.spaces?.length ?? 0) > 1
        ? [{ key: "__remove", icon: <DeleteOutlined />, label: "移除当前空间(不删数据)" }]
        : []),
    ],
    onClick: async (e: { key: string }) => {
      if (e.key === "__new") return newSpace();
      if (e.key === "__import") return apply(await window.daw.importSpace());
      if (e.key === "__remove") return apply(await window.daw.removeSpace(ws!.space!.id!));
      if (e.key !== ws?.space?.id) apply(await window.daw.switchSpace(e.key));
    },
  };

  const identityMenu = {
    items: [
      {
        key: "i",
        label: ws?.identity
          ? `已登录:${ws.identity.name ?? ws.identity.username}(${ws.identity.source === "idaas-token" ? "北斗 IDaaS" : "ept 会话"})`
          : "未登录",
        disabled: true,
      },
      ...(ws?.identity?.expired ? [{ key: "x", label: "登录已过期,请重新登录", disabled: true }] : []),
      { type: "divider" as const },
      { key: "login", label: "🔐 北斗 IDaaS 登录(飞书)" },
      { key: "refresh", label: "♻️ 刷新登录态" },
      { type: "divider" as const },
      { key: "theme", icon: dark ? <BulbOutlined /> : <MoonOutlined />, label: dark ? "浅色模式" : "深色模式" },
    ],
    onClick: async (e: { key: string }) => {
      if (e.key === "theme") return setDark(!dark);
      if (e.key === "login" || e.key === "refresh") {
        message.open({ type: "loading", content: e.key === "login" ? "已打开登录链接,请在浏览器完成确认…" : "正在刷新登录态…", duration: 0 });
        const r = e.key === "login" ? await window.daw.authLogin() : await window.daw.authRefresh();
        message.destroy();
        if (r.ok) message.success(`登录成功:${"userName" in r ? r.userName ?? "" : ""}`);
        else message.error({ content: r.error ?? "登录失败", duration: 8 });
        refresh();
      }
    },
  };

  const meta = PAGE_META[page]!;

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: "#4d6bfe",
          borderRadius: 10,
          fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", Inter, sans-serif',
          fontSize: 13,
        },
        components: {
          Layout: { bodyBg: "transparent", siderBg: "transparent" },
          Card: { borderRadiusLG: 12, paddingLG: 18 },
          Table: { headerBg: "transparent" },
        },
      }}
    >
      <div className="daw-shell">
        {/* 细图标栏(dsh 风格) */}
        <aside className="daw-rail">
          <div className="daw-rail-logo">BW</div>
          {railItems.map(([key, m]) => (
            <Tooltip key={key} title={m.title} placement="right">
              <button
                className={`daw-rail-btn${page === key ? " active" : ""}`}
                data-page={key}
                onClick={() => setPage(key)}
              >
                {m.icon}
              </button>
            </Tooltip>
          ))}
          <div className="daw-rail-spacer" />
          <Dropdown menu={identityMenu} trigger={["click"]} placement="topRight">
            <button className="daw-rail-btn" style={{ display: "flex" }}>
              <Avatar size={24} icon={<UserOutlined />} />
            </button>
          </Dropdown>
        </aside>

        {/* 主区 */}
        <div className="daw-main">
          <header className="daw-topbar">
            <div className="daw-topbar-left">
              <Dropdown menu={spaceMenu} trigger={["click"]}>
                <span style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className="daw-title">{ws?.space?.name ?? ws?.name ?? "未加载"}</span>
                  <span className="daw-sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    / {meta.title} <DownOutlined style={{ fontSize: 10 }} />
                  </span>
                </span>
              </Dropdown>
              <span className="daw-sub">
                指标 {ws?.counts?.metrics ?? "-"} · 数据集 {ws?.counts?.datasets ?? "-"} · 表 {ws?.counts?.physicalTables ?? "-"}
              </span>
            </div>
            <div className="daw-topbar-right">
              <span className={`daw-chip ${ws?.modelConfigured ? "ok" : "warn"}`}>
                <span className="dot" />
                {ws?.modelConfigured ? "模型" : "演示模式"}
              </span>
              <span className={`daw-chip ${ws?.starrocksConfigured ? "ok" : ws?.mockData ? "warn" : ""}`}>
                <span className="dot" />
                {ws?.starrocksConfigured ? "StarRocks" : ws?.mockData ? "演示数据(mock)" : "SR 未配置"}
              </span>
              <span className="daw-chip accent"><span className="dot" />{ws?.role ?? "-"}</span>
              <button className="daw-rail-btn" style={{ width: 32, height: 32 }} onClick={refresh}>
                <ReloadOutlined />
              </button>
            </div>
          </header>

          {(ws?.warnings?.length ?? 0) > 0 && (
            <div style={{ padding: "8px 16px 0" }}>
              <span className="daw-chip warn" style={{ cursor: "default" }}>
                <span className="dot" />{ws!.warnings!.length} 条装载警告(设置页查看)
              </span>
            </div>
          )}

          {page === "chat" && <ChatPage theme={dark} modelConfigured={ws?.modelConfigured} onGoSettings={() => setPage("settings")} />}
          {page === "semantics" && <div className="daw-page"><SemanticsPage role={ws?.role} /></div>}
          {page === "skills" && <div className="daw-page"><SkillsPage role={ws?.role} /></div>}
          {page === "plugins" && <div className="daw-page"><PluginsPage onSaved={refresh} /></div>}
          {page === "audit" && <div className="daw-page"><AuditPage /></div>}
          {page === "settings" && <div className="daw-page"><SettingsPage ws={ws} onRefresh={refresh} /></div>}
        </div>
      </div>
      {contextHolder}
    </ConfigProvider>
  );
}
