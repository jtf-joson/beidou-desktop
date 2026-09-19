import type { ParsedOntology } from "./types";
import { parseOntology } from "./parser";

const valid = `
schemaVersion: 1
version: 1.0.0
domain:
  id: service
  name: 服务
  subdomains:
    - { id: store-ops, name: 门店经营, status: active, topics: [销售业绩, 门店基础], owners: [alice] }
    - { id: user-exp, name: 用户体验, status: draft, topics: [满意度], owners: [] }
classes:
  - id: Store
    name: 门店
    subdomain: store-ops
    topic: 门店基础
    key: store_code
    properties:
      - { id: store_code, name: 门店编码, datatype: string, required: true }
      - { id: city, name: 城市, datatype: string }
    metrics: [store_sales_amt]
  - id: Customer
    name: 客户
    subdomain: user-exp
    topic: 满意度
    properties:
      - { id: customer_id, name: 客户ID, datatype: string, required: true }
relations:
  - id: store_serves_customer
    domain: Store
    range: Customer
    cardinality: "1:N"
    via: { dataset: fact_service_order, keys: { Store: store_code, Customer: customer_id } }
actions:
  - id: diagnose_sales_drop
    name: 门店销售额下滑诊断
    subdomain: store-ops
    subject: Store
    metrics: [store_sales_amt]
    dims: [city, store_code]
`;

describe("parseOntology(fail-open)", () => {
  it("完整 YAML → 全量解析", () => {
    const r = parseOntology(valid);
    expect(r.schemaVersion).toBe(1);
    expect(r.version).toBe("1.0.0");
    expect(r.domain.subdomains).toHaveLength(2);
    expect(r.domain.subdomains[0]!.status).toBe("active");
    expect(r.classes).toHaveLength(2);
    expect(r.classes[0]!.properties[0]!.required).toBe(true);
    expect(r.relations[0]!.via!.keys.Store).toBe("store_code");
    expect(r.actions[0]!.dims).toContain("city");
  });

  it("空/坏 YAML → 空 + warning(不炸)", () => {
    expect(parseOntology("").classes).toEqual([]);
    expect(parseOntology("not: [valid").classes).toEqual([]);
    expect(parseOntology(null as never).classes).toEqual([]);
  });

  it("非法条目跳过并记 warning(fail-open)", () => {
    const partial = `
schemaVersion: 1
version: 0.1.0
domain: { id: svc, name: S, subdomains: [{ id: a, name: A, status: draft, topics: [] }] }
classes:
  - id: Good
    name: 好类
    subdomain: a
    properties: [{ id: k, name: K, datatype: string, required: true }]
  - name: 没ID的
  - id: NoSub
    name: 无子域
    properties: []
`;
    const r = parseOntology(partial);
    expect(r.classes).toHaveLength(1);
    expect(r.classes[0]!.id).toBe("Good");
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("继承解析(extends 单继承)", () => {
    const yaml = `
schemaVersion: 1
version: 0.1.0
domain: { id: svc, name: S, subdomains: [{ id: a, name: A, status: active, topics: [] }] }
classes:
  - id: Base
    name: 基类
    subdomain: a
    properties: [{ id: base_key, name: BK, datatype: string, required: true }]
  - id: Child
    name: 子类
    subdomain: a
    extends: Base
    properties: [{ id: child_attr, name: CA, datatype: string }]
`;
    const r = parseOntology(yaml);
    const child = r.classes.find((c) => c.id === "Child");
    expect(child!.extends).toBe("Base");
  });

  it("status 默认 draft; unknown → draft", () => {
    const yaml = `
schemaVersion: 1
version: 0.1.0
domain: { id: s, name: S, subdomains: [{ id: a, name: A, status: bogus, topics: [] }] }
classes:
  - id: C
    name: C
    subdomain: a
    properties: []
`;
    const r = parseOntology(yaml);
    expect(r.domain.subdomains[0]!.status).toBe("draft");
    expect(r.classes[0]!.status).toBe("draft");
  });
});
