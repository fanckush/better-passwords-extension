import { afterEach, describe, expect, it } from "vitest";
import { pageScheme } from "../src/autofill/page-scheme.ts";

/** The scheme for a field placed inside `html`, on a body painted `body`. */
function schemeAround(html: string, body?: string): string {
  if (body) document.body.style.backgroundColor = body;
  document.body.innerHTML = html;
  return pageScheme(document.querySelector("input") as HTMLInputElement);
}

describe("pageScheme", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  });

  it("is light on a light page and dark on a dark one", () => {
    expect(schemeAround("<input>", "rgb(255, 255, 255)")).toBe("light");
    expect(schemeAround("<input>", "rgb(248, 249, 250)")).toBe("light");
    expect(schemeAround("<input>", "rgb(32, 33, 36)")).toBe("dark");
    expect(schemeAround("<input>", "rgb(18, 18, 18)")).toBe("dark");
  });

  it("goes by the nearest opaque background around the field, not the field's own", () => {
    const html = `<div style="background-color: rgb(20, 20, 20)"><div><input style="background-color: rgb(255, 255, 255)"></div></div>`;
    expect(schemeAround(html, "rgb(255, 255, 255)")).toBe("dark");
  });

  it("counts a mostly opaque background, in either alpha syntax", () => {
    expect(
      schemeAround(`<div style="background-color: rgba(20, 20, 20, 0.8)"><input></div>`, "rgb(255, 255, 255)"),
    ).toBe("dark");
    expect(schemeAround(`<div style="background-color: rgb(20 20 20 / 80%)"><input></div>`, "rgb(255, 255, 255)")).toBe(
      "dark",
    );
  });

  it("skips see-through backgrounds", () => {
    expect(schemeAround(`<div style="background-color: rgba(0, 0, 0, 0.1)"><input></div>`, "rgb(255, 255, 255)")).toBe(
      "light",
    );
    expect(schemeAround(`<div style="background-color: transparent"><input></div>`, "rgb(20, 20, 20)")).toBe("dark");
  });

  it("is light on a page that paints nothing and never opted into dark", () => {
    expect(schemeAround("<input>")).toBe("light");
  });
});
