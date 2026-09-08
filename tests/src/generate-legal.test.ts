import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs build script, no types
import { contactHtml, applyContact } from "../../scripts/generate-legal.mjs";

describe("generate-legal contact slot", () => {
  it("with no email: just the issues link", () => {
    const html = contactHtml(undefined);
    expect(html).toBe(
      'Open an issue at <a href="https://github.com/Jerit3787/markdown-editor/issues" target="_blank" rel="noopener">github.com/Jerit3787/markdown-editor</a>.',
    );
    expect(html).not.toContain("mailto:");
  });

  it("empty / whitespace email is treated as none", () => {
    expect(contactHtml("")).toBe(contactHtml(undefined));
    expect(contactHtml("   ")).toBe(contactHtml(undefined));
  });

  it("with an email: a mailto link before the issues link", () => {
    const html = contactHtml("support@danplace.tech");
    expect(html).toContain('Email <a href="mailto:support@danplace.tech">support@danplace.tech</a>, or open an issue at ');
    expect(html).toContain('href="https://github.com/Jerit3787/markdown-editor/issues"');
  });

  it("escapes an email with HTML-significant characters", () => {
    expect(contactHtml('a"b<c>@x')).toContain("mailto:a&quot;b&lt;c&gt;@x");
  });

  it("applyContact fills the <!--CONTACT--> slot exactly once", () => {
    const tmpl = "<h2>Contact.</h2>\n<p><!--CONTACT--></p>\n";
    const out = applyContact(tmpl, "support@danplace.tech");
    expect(out).not.toContain("<!--CONTACT-->");
    expect(out).toContain('<p>Email <a href="mailto:support@danplace.tech">');
  });
});
