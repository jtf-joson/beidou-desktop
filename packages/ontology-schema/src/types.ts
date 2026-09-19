/** 本体 schema 类型(ontology.yaml → TypeScript) */

export type OntologyStatus = "active" | "draft" | "deprecated";

export interface OntologyProperty {
  id: string;
  name?: string;
  datatype: "string" | "number" | "boolean" | "date" | "enum" | "json";
  required?: boolean;
  description?: string;
  enumRef?: string;
  sensitivity?: "public" | "internal" | "sensitive" | "pii";
}

export interface OntologyClass {
  id: string;
  name: string;
  subdomain: string;
  topic?: string;
  extends?: string;
  key?: string;
  properties: OntologyProperty[];
  /** class 级指标引用(指针层) */
  metrics?: string[];
  /** 治理字段(PoC 只存不强制) */
  status?: OntologyStatus;
  description?: string;
  owners?: string[];
  tags?: string[];
}

export interface OntologyRelationVia {
  dataset: string;
  keys: Record<string, string>;
}

export interface OntologyRelation {
  id: string;
  name?: string;
  domain: string;
  range: string;
  cardinality?: "1:1" | "1:N" | "N:M";
  via?: OntologyRelationVia;
  inverseOf?: string;
  description?: string;
}

export interface OntologyAction {
  id: string;
  name: string;
  subdomain: string;
  subject: string;
  metrics: string[];
  dims?: string[];
  playbook?: string;
  skills?: string[];
  description?: string;
}

export interface OntologySubdomain {
  id: string;
  name: string;
  status: OntologyStatus;
  topics: string[];
  owners: string[];
}

export interface OntologyDomain {
  id: string;
  name: string;
  subdomains: OntologySubdomain[];
}

export interface ParsedOntology {
  schemaVersion: number;
  version: string;
  domain: OntologyDomain;
  classes: OntologyClass[];
  relations: OntologyRelation[];
  actions: OntologyAction[];
  warnings: string[];
}
