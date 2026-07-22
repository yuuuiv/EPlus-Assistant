import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { PaymentOptionGroup, RuntimePaymentOption, SelectorEvidence } from "../../shared/types.js";

export type RuntimePaymentDiscovery =
  | { readonly status: "ready"; readonly groups: readonly PaymentOptionGroup[] }
  | { readonly status: "payment_unavailable"; readonly groups: readonly [] }
  | { readonly status: "payment_delayed"; readonly groups: readonly [] }
  | { readonly status: "manual"; readonly groups: readonly PaymentOptionGroup[]; readonly reason: "ambiguous-control" | "unsupported-control" };

const SUPPORTED_PAYMENT_VALUE_SEGMENTS = ["card", "convenience", "familymart", "seven", "pay-easy", "atm", "bank"] as const;

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function controlType(tagName: string): "select" | "input" | "button" | undefined {
  if (tagName === "select" || tagName === "input" || tagName === "button") {
    return tagName;
  }
  return undefined;
}

function allowedAttributes(
  $: cheerio.CheerioAPI,
  control: Element,
  groupKey: string
): SelectorEvidence["allowedAttributes"] {
  const id = $(control).attr("id");
  const name = $(control).attr("name");
  const type = $(control).attr("type");
  const role = $(control).attr("role");

  return {
    ...(id && !/^i\d+$/iu.test(id) ? { id } : {}),
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    ...(role ? { role } : {}),
    dataPaymentGroup: groupKey
  };
}

function optionLabel($: cheerio.CheerioAPI, group: Element, control: Element, option: Element): string {
  if (control.tagName === "select") {
    return normalizedText($(option).text()) || $(option).attr("value") || "";
  }

  const optionId = $(option).attr("id");
  const label = optionId
    ? $(group)
        .find("label")
        .filter((_index, labelNode) => $(labelNode).attr("for") === optionId)
        .first()
    : $(option).closest("label");
  return normalizedText(label.text()) || $(option).attr("value") || "";
}

function optionNodes($: cheerio.CheerioAPI, group: Element, type: "select" | "input" | "button"): Element[] {
  if (type === "select") {
    const select = $(group).find("select").first();
    return select.find("option[value]").toArray();
  }
  if (type === "input") {
    return $(group).find("input[type='radio'][value]").toArray();
  }
  return $(group).find("button[value]").toArray();
}

function supportedPaymentValue(groupKey: string, domValue: string): boolean {
  return groupKey !== "payment" || SUPPORTED_PAYMENT_VALUE_SEGMENTS.some((segment) => domValue.toLowerCase().includes(segment));
}

function candidateId(groupKey: string, domValue: string, optionOrder: number, duplicateValue: boolean): string {
  return duplicateValue ? `${groupKey}:${domValue}:${optionOrder}` : `${groupKey}:${domValue}`;
}

function buildGroup($: cheerio.CheerioAPI, group: Element, groupOrder: number): PaymentOptionGroup | undefined {
  const groupKey = $(group).attr("data-payment-group")?.trim();
  if (!groupKey) {
    return undefined;
  }

  const controls = $(group).find("select, input[type='radio'], button[value]").toArray();
  const firstControl = controls[0];
  if (!firstControl) {
    return undefined;
  }
  const type = controlType(firstControl.tagName);
  if (!type) {
    return undefined;
  }
  const groupEvidence: SelectorEvidence = {
    scope: "document",
    tag: type,
    groupOrdinal: groupOrder,
    optionOrdinal: 0,
    allowedAttributes: allowedAttributes($, firstControl, groupKey),
    contextGeneration: "static-hint"
  };
  const nodes = optionNodes($, group, type);
  const values = nodes.map((node) => $(node).attr("value") ?? "");
  const labels = nodes.map((node) => optionLabel($, group, firstControl, node));
  const valueCounts = new Map<string, number>();
  const labelCounts = new Map<string, number>();
  for (const value of values) valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
  for (const label of labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);

  const mixedControls = controls.some((control) => controlType(control.tagName) !== type);
  const options: RuntimePaymentOption[] = nodes.map((node, optionOrder) => {
    const domValue = values[optionOrder] ?? "";
    const label = labels[optionOrder] ?? domValue;
    const duplicateValue = (valueCounts.get(domValue) ?? 0) > 1;
    const duplicateLabel = (labelCounts.get(label) ?? 0) > 1;
    const ambiguous = mixedControls || duplicateValue || duplicateLabel;
    const control = type === "select" ? firstControl : node;
    const enabled = !$(node).is(":disabled") && !$(control).is(":disabled");
    const selectorEvidence: SelectorEvidence = {
      ...groupEvidence,
      optionOrdinal: optionOrder,
      allowedAttributes: allowedAttributes($, control, groupKey)
    };
    return {
      candidateId: candidateId(groupKey, domValue, optionOrder, duplicateValue),
      groupKey,
      groupOrder,
      optionOrder,
      controlType: type,
      domValue,
      label,
      enabled,
      supported: !ambiguous && supportedPaymentValue(groupKey, domValue),
      ambiguous,
      selectorEvidence
    };
  });

  return { groupKey, groupOrder, controlType: type, selectorEvidence: groupEvidence, options };
}

export function discoverRuntimePaymentOptions(html: string): RuntimePaymentDiscovery {
  const $ = cheerio.load(html);
  if ($("[data-payment-controls-state='delayed']").length > 0) {
    return { status: "payment_delayed", groups: [] };
  }

  const semanticGroups = $("[data-payment-group]").toArray();
  const groups = semanticGroups
    .map((group, groupOrder) => buildGroup($, group, groupOrder))
    .filter((group): group is PaymentOptionGroup => group !== undefined);

  if (groups.length === 0) {
    if (semanticGroups.length > 0) {
      return { status: "manual", groups: [], reason: "unsupported-control" };
    }
    return { status: "payment_unavailable", groups: [] };
  }
  if (groups.some((group) => group.options.length === 0)) {
    return { status: "manual", groups, reason: "unsupported-control" };
  }
  if (groups.some((group) => group.options.some((option) => option.ambiguous))) {
    return { status: "manual", groups, reason: "ambiguous-control" };
  }
  return { status: "ready", groups };
}
