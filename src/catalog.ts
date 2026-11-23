// Copyright (c) iSPIRT Foundation.
// Licensed under the MIT license.
//
// Dataset catalog (spec §7.2): owner-signed, immutable dataset descriptor
// versions used for discovery and for binding contracts to exact data.

import * as ccfapp from "@microsoft/ccf-app";
import {
  ApiError,
  DATASET_ID_RE,
  digest,
  DIGEST_RE,
  endpoint,
  formatRfc3339,
  HTTPS_URL_RE,
  int,
  JsonObject,
  JsonTable,
  keys,
  nowSeconds,
  obj,
  oneOf,
  optStr,
  pathParam,
  requireBootstrapped,
  str,
  verifySignedRequest,
} from "../packages/depa-ccf-common/src/index";
import { SERVICE_NAME } from "./constants";

export const CONNECTORS = ["s3", "azure-blob", "gcs", "https", "file"] as const;
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface CatalogVersion {
  dataset_id: string;
  version: string;
  descriptor: JsonObject;
  descriptor_digest: string;
  manifest_digest: string;
  publisher: string;
  published_at: string;
  jws: string;
}

export interface CatalogEntry {
  dataset_id: string;
  owner: string;
  latest_version: string;
  versions: string[];
}

const catalogTable = new JsonTable<CatalogEntry>("public:depa.catalog");
const catalogVersionsTable = new JsonTable<CatalogVersion>("public:depa.catalog_versions");

export function getCatalogVersionRecord(datasetId: string, version: string): CatalogVersion | undefined {
  return catalogVersionsTable.get(`${datasetId}@${version}`);
}

export function validateLocation(v: unknown, path: string, allowFederation: boolean): JsonObject {
  const o = obj(v, path);
  keys(o, path, ["connector", "uri"], allowFederation ? ["region", "federation"] : ["region"]);
  oneOf(o.connector, `${path}.connector`, CONNECTORS);
  str(o.uri, `${path}.uri`, { max: 2048 });
  optStr(o.region, `${path}.region`, { max: 64 });
  if (o.federation !== undefined) validateFederation(o.federation, `${path}.federation`);
  return o;
}

export function validateFederation(v: unknown, path: string): void {
  const f = obj(v, path);
  keys(f, path, [], ["aws", "gcp", "azure"]);
  if (f.aws !== undefined) {
    const a = obj(f.aws, `${path}.aws`);
    keys(a, `${path}.aws`, ["role_arn"]);
    str(a.role_arn, `${path}.aws.role_arn`, { re: /^arn:aws[a-z-]*:iam::[0-9]{12}:role\/.+$/, max: 2048 });
  }
  if (f.gcp !== undefined) {
    const g = obj(f.gcp, `${path}.gcp`);
    keys(g, `${path}.gcp`, ["audience"], ["service_account"]);
    str(g.audience, `${path}.gcp.audience`, { max: 2048 });
    optStr(g.service_account, `${path}.gcp.service_account`, { max: 256 });
  }
  if (f.azure !== undefined) {
    const z = obj(f.azure, `${path}.azure`);
    keys(z, `${path}.azure`, ["tenant_id", "client_id"]);
    str(z.tenant_id, `${path}.azure.tenant_id`, { max: 64 });
    str(z.client_id, `${path}.azure.client_id`, { max: 64 });
  }
}

export function validateDescriptor(v: unknown, path = "descriptor"): JsonObject {
  const o = obj(v, path);
  keys(
    o,
    path,
    ["dataset_id", "version", "name", "format", "manifest_digest", "location", "kms"],
    ["description", "schema", "federation", "size_bytes", "records"],
  );
  const datasetId = str(o.dataset_id, `${path}.dataset_id`, { re: DATASET_ID_RE });
  str(o.version, `${path}.version`, { re: VERSION_RE });
  str(o.name, `${path}.name`, { max: 256 });
  optStr(o.description, `${path}.description`, { min: 0, max: 8192 });
  oneOf(o.format, `${path}.format`, ["dedf/1"] as const);
  str(o.manifest_digest, `${path}.manifest_digest`, { re: DIGEST_RE });
  if (o.schema !== undefined) obj(o.schema, `${path}.schema`);
  validateLocation(o.location, `${path}.location`, false);
  if (o.federation !== undefined) validateFederation(o.federation, `${path}.federation`);
  const kms = obj(o.kms, `${path}.kms`);
  keys(kms, `${path}.kms`, ["url", "kid"]);
  str(kms.url, `${path}.kms.url`, { re: HTTPS_URL_RE, max: 512 });
  const kid = str(kms.kid, `${path}.kms.kid`, { max: 200 });
  if (!kid.startsWith(`${datasetId}#`)) throw ApiError.badRequest(`${path}.kms.kid: must be a key of ${datasetId}`, "invalid_input");
  if (o.size_bytes !== undefined) int(o.size_bytes, `${path}.size_bytes`, { min: 0 });
  if (o.records !== undefined) int(o.records, `${path}.records`, { min: 0 });
  return o;
}

function datasetIdFromPath(request: ccfapp.Request): string {
  const id = `${pathParam(request, "owner")}/${pathParam(request, "name")}`;
  if (!DATASET_ID_RE.test(id)) throw ApiError.badRequest("invalid dataset id in path");
  return id;
}

export const publishDataset = endpoint("catalog.publish", (request) => {
  requireBootstrapped();
  const v = verifySignedRequest(request, { service: SERVICE_NAME, op: "catalog.publish", roles: ["tdp", "tdc"] });
  const descriptor = validateDescriptor(v.payload.body, "body");
  const datasetId = descriptor.dataset_id as string;
  const version = descriptor.version as string;
  const owner = datasetId.slice(0, datasetId.indexOf("/"));
  if (owner !== v.party.party_id) throw ApiError.forbidden("only the dataset owner may publish", "not_owner");
  const key = `${datasetId}@${version}`;
  if (catalogVersionsTable.has(key)) throw ApiError.conflict(`version ${version} of ${datasetId} is already published (immutable)`, "exists");
  const record: CatalogVersion = {
    dataset_id: datasetId,
    version,
    descriptor,
    descriptor_digest: digest(descriptor),
    manifest_digest: descriptor.manifest_digest as string,
    publisher: v.party.party_id,
    published_at: formatRfc3339(nowSeconds()),
    jws: v.jws,
  };
  catalogVersionsTable.set(key, record);
  const entry = catalogTable.get(datasetId);
  catalogTable.set(datasetId, {
    dataset_id: datasetId,
    owner,
    latest_version: version,
    versions: [...(entry?.versions ?? []), version],
  });
  return record;
});

export const listCatalog = endpoint("catalog.list", () => ({
  datasets: catalogTable.entries().map(([, e]) => e),
}));

export const getCatalogEntry = endpoint("catalog.get", (request) => {
  const id = datasetIdFromPath(request);
  const entry = catalogTable.get(id);
  if (!entry) throw ApiError.notFound(`dataset ${id} not in catalog`);
  return { ...entry, latest: getCatalogVersionRecord(id, entry.latest_version) };
});

export const getCatalogVersion = endpoint("catalog.get_version", (request) => {
  const id = datasetIdFromPath(request);
  const version = pathParam(request, "version");
  const record = getCatalogVersionRecord(id, version);
  if (!record) throw ApiError.notFound(`dataset ${id} version ${version} not found`);
  return record;
});
