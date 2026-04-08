import { describe, expect, test } from "bun:test";
import { entityToSlug, normalizeRelationType } from "./entity-link";

describe("entityToSlug", () => {
  test("converts person name", () => {
    expect(entityToSlug("Ali Partovi", "person")).toBe("people/ali-partovi");
  });

  test("converts company name", () => {
    expect(entityToSlug("River AI", "company")).toBe("companies/river-ai");
  });

  test("converts organization name", () => {
    expect(entityToSlug("Code.org", "organization")).toBe(
      "organizations/code-org",
    );
  });

  test("converts project name", () => {
    expect(entityToSlug("Project X", "project")).toBe("projects/project-x");
  });

  test("converts event name", () => {
    expect(entityToSlug("WWDC 2025", "event")).toBe("events/wwdc-2025");
  });

  test("defaults unknown type to entities", () => {
    expect(entityToSlug("Unknown", "other")).toBe("entities/unknown");
  });

  test("preserves Chinese characters", () => {
    expect(entityToSlug("马云", "person")).toBe("people/马云");
  });

  test("handles mixed English and Chinese", () => {
    expect(entityToSlug("马云 Alibaba", "company")).toBe(
      "companies/马云-alibaba",
    );
  });

  test("handles empty name", () => {
    expect(entityToSlug("", "person")).toBe("people/untitled");
  });

  test("handles whitespace only name", () => {
    expect(entityToSlug("   ", "company")).toBe("companies/untitled");
  });

  test("normalizes consecutive separators", () => {
    expect(entityToSlug("Ali  Partovi", "person")).toBe(
      "people/ali-partovi",
    );
  });

  test("removes leading/trailing separators", () => {
    expect(entityToSlug("-Ali Partovi-", "person")).toBe(
      "people/ali-partovi",
    );
  });
});

describe("normalizeRelationType", () => {
  test("handles exact matches", () => {
    expect(normalizeRelationType("founder_of")).toBe("founder_of");
    expect(normalizeRelationType("works_at")).toBe("works_at");
  });

  test("handles variations", () => {
    expect(normalizeRelationType("founder of")).toBe("founder_of");
    expect(normalizeRelationType("works at")).toBe("works_at");
    expect(normalizeRelationType("leads")).toBe("leader_of");
    expect(normalizeRelationType("collaboration")).toBe("collaborates_with");
    expect(normalizeRelationType("competitor")).toBe("competes_with");
    expect(normalizeRelationType("buys")).toBe("acquired");
    expect(normalizeRelationType("belongs to")).toBe("part_of");
    expect(normalizeRelationType("invests")).toBe("invested_in");
    expect(normalizeRelationType("mentions")).toBe("mentioned_in");
  });

  test("defaults to related_to", () => {
    expect(normalizeRelationType("random_type")).toBe("related_to");
  });
});
