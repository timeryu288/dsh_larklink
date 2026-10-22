export type {
  Brand,
  BrandEvidence,
  ResourceType,
  ParsedDoc,
  Binding,
  BindingStatus,
  Pin,
  Registry,
} from "./types.js";
export { parseDoc } from "./url.js";
export {
  createRegistry,
  findBinding,
  routableBindings,
  findPin,
  upsertPin,
  removePin,
  upsertBinding,
  removeBinding,
  validateRegistry,
  type RegistryIssue,
} from "./registry.js";
export {
  resolve,
  ResolveError,
  type Confidence,
  type Candidate,
  type ResolveOk,
  type ResolveAmbiguous,
  type ResolveResult,
  type ResolveErrorCode,
  type ResolveOptions,
} from "./resolve.js";
