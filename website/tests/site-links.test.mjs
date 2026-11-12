import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTALL_LINK_ATTRIBUTES,
  INSTALL_URL,
  linkAttributes,
} from "../src/config/site-links.mjs";

test("download CTAs stay hidden until a trusted public release is configured", () => {
  assert.equal(INSTALL_URL, null);
  assert.equal(INSTALL_LINK_ATTRIBUTES, null);
});

test("internal documentation links stay in the current browsing context", () => {
  assert.deepEqual(linkAttributes("/features/invoices/"), {
    href: "/features/invoices/",
  });
});

test("future HTTPS installer links receive safe external attributes", () => {
  assert.deepEqual(linkAttributes("https://downloads.example.com/WeMail.exe"), {
    href: "https://downloads.example.com/WeMail.exe",
    target: "_blank",
    rel: "noopener noreferrer",
  });
});

test("empty, fragment-only, protocol-relative, insecure, malformed, and whitespace HTTPS targets are rejected", () => {
  for (const value of [
    "",
    "#",
    "//downloads.example.com/app.exe",
    "http://example.com/app.exe",
    "https://?bad",
    "https://#fragment",
    " https://downloads.example.com/app.exe",
    "https://downloads.example.com/app.exe ",
    "https://downloads.example.com/app.exe\n",
    "https://downloads.example.com/app.exe\t",
    "https://downloads.example.com/app.exe\u0000",
  ]) {
    assert.throws(() => linkAttributes(value), /valid internal path or HTTPS URL/);
  }
});
