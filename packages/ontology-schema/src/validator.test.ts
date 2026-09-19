import { describe, expect, it } from "vitest";
import { validateOntology } from "./validator";
import type { ParsedOntology } from "./types";

const mk = (over: Partial<ParsedOntology> = {}): ParsedOntology => ({
  schemaVersion: 1,
  version: "1.0.0",
  domain: {
    id: "svc", name: "服务",
    subdomains: [{ id: "store-ops", name: "门店", status: "active", topics: ["销售"], owners: ["alice"] }],
  },
  classes: [
    { id: "Store", name: "门店", subdomain: "store-ops", topic: "销售", key: "store_code", properties: [
      { id: "store_code", name: "编码", datatype: "string", required: true },
    ]},
  ],
  relations: [],
  actions: [],
  warnings: [],
  ...over,
});

describe("validateOntology(fail-closed,CI/publish 用)", () => {
  it("合法本体 → 零 issue", () => {
    expect(validateOntology(mk())).toEqual([]);
  });

  it("extends 环 → error", () => {
    const r = validateOntology(mk({
      classes: [
        { id: "A", name: "A", subdomain: "store-ops", extends: "B", properties: [] },
        { id: "B", name: "B", subdomain: "store-ops", extends: "A", properties: [] },
      ],
    }));
    expect(r.some((i) => i.rule === "EXTENDS_CYCLE" && i.level === "error")).toBe(true);
  });

  it("extends 指向不存在的 class → error", () => {
    const r = validateOntology(mk({
      classes: [{ id: "Child", name: "C", subdomain: "store-ops", extends: "Ghost", properties: [] }],
    }));
    expect(r.some((i) => i.rule === "EXTENDS_NOT_FOUND" && i.level === "error")).toBe(true);
  });

  it("subdomain 引用不存在 → error", () => {
    const r = validateOntology(mk({
      classes: [{ id: "X", name: "X", subdomain: "ghost-domain", properties: [] }],
    }));
    expect(r.some((i) => i.rule === "SUBDOMAIN_NOT_FOUND" && i.level === "error")).toBe(true);
  });

  it("topic 不在 subdomain.topics 中 → error", () => {
    const r = validateOntology(mk({
      classes: [{ id: "X", name: "X", subdomain: "store-ops", topic: "不存在的话题", properties: [] }],
    }));
    expect(r.some((i) => i.rule === "TOPIC_NOT_IN_SUBDOMAIN" && i.level === "error")).toBe(true);
  });

  it("key 不在 properties 中 → error", () => {
    const r = validateOntology(mk({
      classes: [{ id: "X", name: "X", subdomain: "store-ops", key: "ghost_key", properties: [{ id: "a", name: "A", datatype: "string" }] }],
    }));
    expect(r.some((i) => i.rule === "KEY_NOT_IN_PROPERTIES" && i.level === "error")).toBe(true);
  });

  it("relation domain/range 指向不存在的 class → error", () => {
    const r = validateOntology(mk({
      relations: [{ id: "r1", name: "R", domain: "Ghost", range: "Store" }],
    }));
    expect(r.some((i) => i.rule === "RELATION_CLASS_NOT_FOUND" && i.level === "error")).toBe(true);
  });

  it("action.subject 不存在 → error;action.metrics 引用 class.metrics → warn", () => {
    const r = validateOntology(mk({
      actions: [{ id: "a1", name: "A", subdomain: "store-ops", subject: "Ghost", metrics: ["m"] }],
    }));
    expect(r.some((i) => i.rule === "ACTION_SUBJECT_NOT_FOUND" && i.level === "error")).toBe(true);
  });

  it("schemaVersion=0 → error(必须为 1)", () => {
    const r = validateOntology(mk({ schemaVersion: 0 }));
    expect(r.some((i) => i.rule === "SCHEMA_VERSION_INVALID" && i.level === "error")).toBe(true);
  });

  it("class id 重复 → error", () => {
    const r = validateOntology(mk({
      classes: [
        { id: "Dup", name: "A", subdomain: "store-ops", properties: [] },
        { id: "Dup", name: "B", subdomain: "store-ops", properties: [] },
      ],
    }));
    expect(r.some((i) => i.rule === "DUPLICATE_ID" && i.level === "error")).toBe(true);
  });
});
