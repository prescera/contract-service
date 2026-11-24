// Copyright (c) iSPIRT Foundation.
// Licensed under the MIT license.

import { describe, expect, it } from "@jest/globals";
import { validateFederation } from "../../src/catalog";

describe("validateFederation (azure)", () => {
  it("accepts the SAS broker form", () => {
    expect(() =>
      validateFederation({ azure: { broker_url: "https://tdp-1-broker.azurewebsites.net", audience: "api://depa-federation-broker/acct" } }, "f"),
    ).not.toThrow();
  });

  it("accepts the Entra form", () => {
    expect(() => validateFederation({ azure: { tenant_id: "t", client_id: "c" } }, "f")).not.toThrow();
  });

  it.each([
    [{ broker_url: "http://insecure.example", audience: "a" }],
    [{ broker_url: "https://b.example" }],
    [{ broker_url: "https://b.example", audience: "a", tenant_id: "t" }],
    [{ tenant_id: "t" }],
    [{}],
  ])("rejects %j", (azure) => {
    expect(() => validateFederation({ azure }, "f")).toThrow();
  });
});
