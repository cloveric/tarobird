import { Parser } from "htmlparser2";
import type { OmpExtensionUiRequest } from "./omp-rpc-protocol.js";

export interface OmpParsedFormOption {
  value: string;
  label: string;
  description?: string;
}

export interface OmpParsedFormField {
  name: string;
  kind: "radio" | "checkbox" | "select" | "text" | "textarea" | "number";
  label: string;
  header?: string;
  placeholder?: string;
  prefill?: string;
  options: OmpParsedFormOption[];
  required: boolean;
}

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Parse an omp `extension_ui_request` with `method: "form"` (sent by omp's built-in
 * `ask` tool or `ui.formDialog`) into structured form fields that TaroBird can
 * render with `AskUserQuestion` and map back to `{ data: Record<string, string | number | string[]> }`.
 */
export function parseOmpFormRequest(req: OmpExtensionUiRequest): OmpParsedFormField[] {
  if (Array.isArray(req.fields) && req.fields.length > 0) {
    const fields: OmpParsedFormField[] = [];
    for (const raw of req.fields) {
      if (!raw || typeof raw.name !== "string" || !raw.name.trim()) continue;
      const type = (raw.type || "text").toLowerCase();
      const options: OmpParsedFormOption[] = Array.isArray(raw.options)
        ? raw.options.map(opt => typeof opt === "string"
          ? { value: opt, label: opt }
          : { value: opt.value ?? opt.label, label: opt.label, ...(opt.description ? { description: opt.description } : {}) })
        : [];
      const kind: OmpParsedFormField["kind"] =
        type === "checkbox" || type === "multi" || type === "multiselect" ? "checkbox"
          : type === "radio" ? "radio"
            : type === "select" ? "select"
              : type === "textarea" || type === "multiline" ? "textarea"
                : type === "number" ? "number"
                  : options.length > 0 ? "radio" : "text";
      fields.push({
        name: raw.name.trim(),
        kind,
        label: raw.label?.trim() || raw.name.trim(),
        ...(raw.placeholder ? { placeholder: raw.placeholder } : {}),
        ...(raw.value ? { prefill: raw.value } : {}),
        options,
        required: raw.required !== false,
      });
    }
    if (fields.length > 0) return fields;
  }

  if (typeof req.html !== "string" || !req.html.trim()) return [];

  const fieldsByName = new Map<string, OmpParsedFormField>();
  const fieldOrder: OmpParsedFormField[] = [];
  const labelForId = new Map<string, string>();
  const ensureField = (name: string, kind: OmpParsedFormField["kind"], label: string, extra: Partial<OmpParsedFormField> = {}): OmpParsedFormField => {
    let field = fieldsByName.get(name);
    if (!field) {
      field = { name, kind, label: label || name, options: [], required: extra.required ?? true, ...extra };
      fieldsByName.set(name, field);
      fieldOrder.push(field);
    }
    return field;
  };

  let currentLegend = "";
  let inLegend = false;
  let legendBuf = "";
  let inLabel = false;
  let labelForAttr: string | undefined;
  let labelBuf = "";
  let labelInputTarget: { field: OmpParsedFormField; option?: OmpParsedFormOption } | undefined;
  let currentSelect: OmpParsedFormField | undefined;
  let currentOption: OmpParsedFormOption | undefined;
  let optionBuf = "";
  let currentTextarea: OmpParsedFormField | undefined;
  let textareaBuf = "";
  const idToField = new Map<string, { field: OmpParsedFormField; option?: OmpParsedFormOption }>();

  const parser = new Parser({
    onopentag(tag, attrs) {
      const name = tag.toLowerCase();
      if (name === "fieldset") {
        currentLegend = "";
        return;
      }
      if (name === "legend") {
        inLegend = true;
        legendBuf = "";
        return;
      }
      if (name === "label") {
        inLabel = true;
        labelForAttr = attrs.for;
        labelBuf = "";
        labelInputTarget = undefined;
        return;
      }
      if (name === "input") {
        const type = (attrs.type || "text").toLowerCase();
        if (["submit", "button", "reset", "hidden"].includes(type)) return;
        const fieldName = attrs.name?.trim() || attrs.id?.trim();
        if (!fieldName) return;
        const fieldId = attrs.id?.trim();
        const labelFromFor = fieldId ? labelForId.get(fieldId) : undefined;
        if (type === "radio" || type === "checkbox") {
          const val = attrs.value ?? "on";
          const field = ensureField(fieldName, type, currentLegend || labelFromFor || fieldName, {
            header: currentLegend || undefined,
            required: Object.hasOwn(attrs, "required"),
          });
          const opt: OmpParsedFormOption = { value: val, label: labelFromFor || val };
          field.options.push(opt);
          if (fieldId) idToField.set(fieldId, { field, option: opt });
          if (inLabel) labelInputTarget = { field, option: opt };
          return;
        }
        const kind: OmpParsedFormField["kind"] = type === "number" ? "number" : "text";
        const field = ensureField(fieldName, kind, labelFromFor || currentLegend || attrs.placeholder || fieldName, {
          header: currentLegend || undefined,
          ...(attrs.placeholder ? { placeholder: attrs.placeholder } : {}),
          ...(attrs.value ? { prefill: attrs.value } : {}),
          required: Object.hasOwn(attrs, "required"),
        });
        if (fieldId) idToField.set(fieldId, { field });
        if (inLabel) labelInputTarget = { field };
        return;
      }
      if (name === "select") {
        const fieldName = attrs.name?.trim() || attrs.id?.trim();
        if (!fieldName) return;
        const fieldId = attrs.id?.trim();
        const labelFromFor = fieldId ? labelForId.get(fieldId) : undefined;
        const multi = Object.hasOwn(attrs, "multiple");
        currentSelect = ensureField(fieldName, multi ? "checkbox" : "select", labelFromFor || currentLegend || fieldName, {
          header: currentLegend || undefined,
          required: Object.hasOwn(attrs, "required"),
        });
        if (fieldId) idToField.set(fieldId, { field: currentSelect });
        if (inLabel) labelInputTarget = { field: currentSelect };
        return;
      }
      if (name === "option" && currentSelect) {
        currentOption = { value: attrs.value ?? "", label: "" };
        optionBuf = "";
        return;
      }
      if (name === "textarea") {
        const fieldName = attrs.name?.trim() || attrs.id?.trim();
        if (!fieldName) return;
        const fieldId = attrs.id?.trim();
        const labelFromFor = fieldId ? labelForId.get(fieldId) : undefined;
        currentTextarea = ensureField(fieldName, "textarea", labelFromFor || currentLegend || attrs.placeholder || fieldName, {
          header: currentLegend || undefined,
          ...(attrs.placeholder ? { placeholder: attrs.placeholder } : {}),
          required: Object.hasOwn(attrs, "required"),
        });
        textareaBuf = "";
        if (fieldId) idToField.set(fieldId, { field: currentTextarea });
        if (inLabel) labelInputTarget = { field: currentTextarea };
      }
    },
    ontext(text) {
      if (inLegend) legendBuf += text;
      if (inLabel && !currentOption && !currentTextarea) labelBuf += text;
      if (currentOption) optionBuf += text;
      if (currentTextarea) textareaBuf += text;
    },
    onclosetag(tag) {
      const name = tag.toLowerCase();
      if (name === "legend") {
        inLegend = false;
        currentLegend = cleanText(legendBuf);
        return;
      }
      if (name === "fieldset") {
        currentLegend = "";
        return;
      }
      if (name === "option" && currentSelect && currentOption) {
        const text = cleanText(optionBuf);
        currentOption.label = text || currentOption.value;
        if (!currentOption.value) currentOption.value = currentOption.label;
        if (currentOption.label) currentSelect.options.push(currentOption);
        currentOption = undefined;
        optionBuf = "";
        return;
      }
      if (name === "select") {
        currentSelect = undefined;
        return;
      }
      if (name === "textarea" && currentTextarea) {
        const prefill = textareaBuf.trim();
        if (prefill) currentTextarea.prefill = prefill;
        currentTextarea = undefined;
        textareaBuf = "";
        return;
      }
      if (name === "label") {
        const text = cleanText(labelBuf);
        if (text) {
          if (labelInputTarget?.option) {
            labelInputTarget.option.label = text;
          } else if (labelInputTarget?.field && labelInputTarget.field.label === labelInputTarget.field.name) {
            labelInputTarget.field.label = text;
          } else if (labelForAttr) {
            labelForId.set(labelForAttr, text);
            const target = idToField.get(labelForAttr);
            if (target?.option) target.option.label = text;
            else if (target?.field && target.field.label === target.field.name) target.field.label = text;
          }
        }
        inLabel = false;
        labelForAttr = undefined;
        labelBuf = "";
        labelInputTarget = undefined;
      }
    },
  });

  parser.write(req.html);
  parser.end();

  // Filter out broken radio/checkbox/select fields with zero options.
  return fieldOrder.filter(field =>
    field.kind === "text" || field.kind === "textarea" || field.kind === "number" || field.options.length > 0,
  );
}
