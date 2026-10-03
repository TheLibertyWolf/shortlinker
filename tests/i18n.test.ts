import { describe, expect, it } from "vitest";
import { localizeHtml, translate } from "../src/i18n.js";

describe("admin localization", () => {
  it("keeps English unchanged", () => {
    expect(translate("en", "Profile")).toBe("Profile");
    expect(localizeHtml("en", "<button>Save profile</button>")).toBe("<button>Save profile</button>");
  });

  it("translates exact text nodes and accessible attributes to French", () => {
    expect(translate("fr", "Profile")).toBe("Profil");
    expect(localizeHtml("fr", '<button title="Open profile">Save profile</button>'))
      .toBe('<button title="Ouvrir le profil">Enregistrer le profil</button>');
  });

  it("does not alter dynamic content", () => {
    expect(localizeHtml("fr", "<code>shurl.be/Overview</code>")).toBe("<code>shurl.be/Overview</code>");
  });
});
