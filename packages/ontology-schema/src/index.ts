export { parseOntology } from "./parser";
export { validateOntology } from "./validator";
export { loadBindings, type Bindings } from "./bindings";
export { migrateEntities, type EntitiesLegacy } from "./migrate";
export type {
  ParsedOntology, OntologyDomain, OntologySubdomain, OntologyClass,
  OntologyProperty, OntologyRelation, OntologyRelationVia, OntologyAction, OntologyStatus,
} from "./types";
export type { ValidationIssue } from "./validator";
