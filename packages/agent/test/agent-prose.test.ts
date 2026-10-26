// Covers the prose guard on model-written text: digits only through allowed
// placeholders (C3.4), figures and phone numbers written in words, links and
// emails removed and counted (C3.5), direction controls stripped (C3.7), the
// length and empty refusals, the optional trend-claim refusal, the always-on
// sensitive-trait, accusation, release-claim and family-claim refusals, and which tag
// names and tag families may be shown as chips. It does not cover spelled-out numbers off the number-word list
// (a fused "fortytwo"), disguised links such as "evil dot com", which are named
// non-goals, synonyms for rising, claims or accusations the patterns do not
// list, claims about religion, ethnicity, politics or most health topics,
// which only the prompts forbid in prose, or the rendering of the result in
// the browser.
import { describe, expect, it } from "vitest";
import { checkProse, fillPlaceholders, isShowableTag, isShowableTagId } from "../src/agent/prose.js";

const ANGLE = { maxChars: 200, placeholders: [] as const };

describe("checkProse", () => {
  it("refuses a model-written figure (C3.4)", () => {
    const result = checkProse("Book them, fit 9.7/10", ANGLE);

    expect(result).toEqual({ ok: false, text: "", removed: { links: 0, emails: 0 }, reason: "digits" });
  });

  it("refuses digits in scripts other than 0 to 9", () => {
    for (const text of ["fit ９ of ten", "fit ٩", "two² shows", "chapter Ⅷ"]) {
      expect(checkProse(text, ANGLE).reason).toBe("digits");
    }
  });

  it("refuses a figure or a phone number written in words as digits (C3.4, C3.5)", () => {
    for (const text of [
      "his three million fans",
      "a two-time Emmy winner",
      "a dozen awards",
      "ninety percent of listeners",
      "call five five five one two one two",
    ]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: false, text: "", removed: { links: 0, emails: 0 }, reason: "digits" });
    }
  });

  it("refuses every count, order and frequency word from two up, in any case (A2-4)", () => {
    const words = [
      ..."two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" "),
      ..."twenty thirty forty fifty sixty seventy eighty ninety".split(" "),
      ..."second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth".split(" "),
      ..."sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth".split(" "),
      ..."ninetieth hundredth decade decades twice thrice dozen dozens".split(" "),
    ];
    for (const word of words) {
      for (const text of [`Talk about the ${word} thing`, word.toUpperCase()]) {
        expect(checkProse(text, ANGLE), text).toEqual({ ok: false, text: "", removed: { links: 0, emails: 0 }, reason: "digits" });
      }
    }
    for (const text of [
      "Twenty-five years of sketch",
      "Forty two rooms",
      "Fresh off her second Emmy and ten years on a hit sitcom.",
      "Two Grammys and a decade on tour.",
      "She has won twice.",
    ]) {
      expect(checkProse(text, ANGLE).reason, text).toBe("digits");
    }
  });

  it("refuses a multiplier, a -fold word and a large ordinal as digits", () => {
    for (const text of ["A double Emmy winner", "Her triple-platinum run", "A twofold rise", "A quadruple threat", "his millionth subscriber"]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: false, text: "", removed: { links: 0, emails: 0 }, reason: "digits" });
    }
    for (const text of ["A quintuple crown", "A tenfold jump", "A HUNDREDFOLD return", "Her thousandth show", "The billionth view"]) {
      expect(checkProse(text, ANGLE).reason, text).toBe("digits");
    }
  });

  it("refuses a multiplier with a final d, sextuple and trillionth as digits, and lets doubles tennis pass", () => {
    for (const text of ["She doubled her audience", "Sales tripled after the tour", "A sextuple threat", "Her trillionth view"]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: false, text: "", removed: { links: 0, emails: 0 }, reason: "digits" });
    }
    expect(checkProse("doubles tennis", ANGLE)).toEqual({ ok: true, text: "doubles tennis", removed: { links: 0, emails: 0 } });
  });

  it("refuses the -ing and -s forms of a multiplier, halving and a century as digits, and lets doubles tennis, half and quarter pass (audit R2)", () => {
    for (const text of [
      "She keeps doubling her audience",
      "His audience tripling since the tour",
      "Quadrupling her reach",
      "Her audience doubles every year",
      "Her sales triples",
      "Her reach quadruples",
      "Her ratings halved",
      "Halving the runtime",
      "half a century in comedy",
      "a quarter century on stage",
      "a century of jazz",
      "Centuries of folk song",
    ]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: false, text: "", removed: { links: 0, emails: 0 }, reason: "digits" });
    }
    for (const text of ["She plays doubles tennis", "A doubles match at the open", "Her doubles partner on tour", "half the fun", "a quarter of the episode"]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });

  it("lets one, first and single pass, and longer words that only start like a number word", () => {
    for (const text of ["one plain conversation", "first users", "a single idea", "the first time on a podcast", "seconds", "secondary school", "doubles tennis"]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });

  it("accepts a number only through a listed placeholder", () => {
    expect(checkProse("Their fans love {{fit}}", { maxChars: 200, placeholders: ["fit"] })).toEqual({
      ok: true,
      text: "Their fans love {{fit}}",
      removed: { links: 0, emails: 0 },
    });
    expect(checkProse("Ranked {{rank1}} here", { maxChars: 200, placeholders: ["rank1"] }).ok).toBe(true);
  });

  it("treats an unlisted placeholder as plain text", () => {
    expect(checkProse("{{other}} 5", { maxChars: 200, placeholders: ["fit"] }).reason).toBe("digits");
    expect(checkProse("Ranked {{rank1}} here", { maxChars: 200, placeholders: ["fit"] }).reason).toBe("digits");
  });

  it("removes a bare domain with a path and an email, and counts both (C3.5)", () => {
    const result = checkProse("see evil.example/login or mail bob@evil.example", ANGLE);

    expect(result).toEqual({ ok: true, text: "see or mail", removed: { links: 1, emails: 1 } });
  });

  it("removes scheme links, protocol-relative links and top-level domains off linkify's short list", () => {
    const result = checkProse(
      "Try https://evil.example, //evil.example/x, evil.xyz/login and mailto:bob@evil.example today",
      ANGLE,
    );

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual({ links: 3, emails: 1 });
    expect(result.text).not.toMatch(/evil|https|mailto|@/);
  });

  it("refuses prose that is only a link once the link is gone", () => {
    expect(checkProse("evil.example", ANGLE)).toEqual({ ok: false, text: "", removed: { links: 1, emails: 0 }, reason: "empty" });
  });

  it("strips a right-to-left override and other direction controls (C3.7)", () => {
    const result = checkProse("A great ‮guest‬ for ⁧this⁩ show", ANGLE);

    expect(result.ok).toBe(true);
    expect(result.text).toBe("A great guest for this show");
  });

  it("refuses 201 characters at maxChars 200 and accepts 200", () => {
    expect(checkProse("a".repeat(201), ANGLE).reason).toBe("too_long");
    expect(checkProse("a".repeat(200), ANGLE).ok).toBe(true);
  });

  it("refuses empty and whitespace-only prose", () => {
    expect(checkProse("", ANGLE).reason).toBe("empty");
    expect(checkProse(" \n\t‏ ", ANGLE).reason).toBe("empty");
  });

  it("throws on a maxChars that is not a positive integer", () => {
    expect(() => checkProse("fine", { maxChars: 0, placeholders: [] })).toThrow(RangeError);
    expect(() => checkProse("fine", { maxChars: 1.5, placeholders: [] })).toThrow(RangeError);
  });
});

describe("checkProse with noTrendClaims", () => {
  const NO_TRENDS = { ...ANGLE, noTrendClaims: true };

  it("refuses each trend claim, in any case and with spaces or dashes", () => {
    for (const text of [
      "Rising comedy voice",
      "A comic on the rise",
      "An up and coming host",
      "An up-and-coming host",
      "An up‑and‑coming host",
      "Their breakout year",
      "Trending with younger fans",
      "A buzzy new voice",
      "A RISING STAR of sketch",
      "A surging comic",
      "Growing in popularity with younger fans",
    ]) {
      expect(checkProse(text, NO_TRENDS), text).toEqual({ ok: false, text: "", removed: { links: 0, emails: 0 }, reason: "trend_claim" });
    }
  });

  it("a breakout role, film or other named work is not a trend claim", () => {
    for (const text of [
      "Reinventing yourself after a breakout role",
      "Her breakout film and what came after",
      "The breakout album that changed their sound",
      "A breakout performance on stage",
      "Life after a breakout-role year",
    ]) {
      expect(checkProse(text, NO_TRENDS), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });

  it("breakout as momentum is still a trend claim", () => {
    for (const text of ["Their breakout year", "A breakout star", "A true breakout", "A breakout moment for the band", "Breakout"]) {
      expect(checkProse(text, NO_TRENDS).reason, text).toBe("trend_claim");
    }
  });

  it("lets words that only contain rising pass, because the match is on word boundaries", () => {
    for (const text of ["A surprising guest", "A film about an uprising", "Questions arising from the show", "Many risings in one story"]) {
      expect(checkProse(text, NO_TRENDS), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });

  it("allows trend words when the option is off or unset", () => {
    expect(checkProse("A rising comedy voice", ANGLE).ok).toBe(true);
    expect(checkProse("A rising comedy voice", { ...ANGLE, noTrendClaims: false }).ok).toBe(true);
  });

  it("checks the text outside listed placeholders, so a placeholder's name never trips it", () => {
    expect(checkProse("Interest is {{rising}}", { maxChars: 200, placeholders: ["rising"], noTrendClaims: true }).ok).toBe(true);
    expect(checkProse("Interest is {{rising}}", { maxChars: 200, placeholders: [], noTrendClaims: true }).reason).toBe("trend_claim");
  });
});

describe("checkProse sensitive traits", () => {
  it("a claim about a guest's sexuality, gender identity or health is refused", () => {
    for (const text of [
      "the friendships that shape a queer comedy career",
      "Life as a gay comic",
      "Her coming out story",
      "He came out as bisexual",
      "A trans actor's path",
      "Being non-binary in Hollywood",
      "Growing up LGBTQ",
      "After being diagnosed with ADHD",
      "Raising a child with autism",
      "Her pregnancy and the tour",
      "Living with HIV",
    ]) {
      for (const noTrendClaims of [true, false]) {
        expect(checkProse(text, { ...ANGLE, noTrendClaims }), `${text} ${noTrendClaims}`).toEqual({
          ok: false,
          text: "",
          removed: { links: 0, emails: 0 },
          reason: "sensitive_trait",
        });
      }
    }
  });

  it("every plural, derived form and named diagnosis is refused", () => {
    for (const text of [
      "Queerness on late night",
      "Gays and their allies",
      "Lesbians in stand-up",
      "Bisexuals on screen",
      "Bisexuality and fame",
      "Pansexuals in music",
      "Pansexuality and art",
      "Asexuals in fiction",
      "Asexuality and dating",
      "Transgenders in sport",
      "A genderqueer voice",
      "Being gender fluid on tour",
      "A genderfluid performer",
      "Being gender-fluid on tour",
      "An intersex athlete",
      "Living with PTSD",
      "His OCD and the writing room",
      "Her Parkinson's and the stage",
      "Her Parkinson’s and the stage",
      "Caring through Alzheimer's",
      "A father with dementia",
      "Dyslexia and the page",
      "A dyslexic novelist",
      "Tourette's on stage",
      "Epilepsy and touring",
      "An epileptic drummer",
      "Anorexia and the spotlight",
      "An anorexic teenager",
      "Bulimia and dancing",
      "A bulimic model",
      "Chemotherapy between shows",
      "Terminally ill and still writing",
      "Miscarriages and a comeback",
    ]) {
      for (const noTrendClaims of [true, false]) {
        expect(checkProse(text, { ...ANGLE, noTrendClaims }), `${text} ${noTrendClaims}`).toEqual({
          ok: false,
          text: "",
          removed: { links: 0, emails: 0 },
          reason: "sensitive_trait",
        });
      }
    }
  });

  it("topic words and lookalikes are not sensitive traits", () => {
    for (const text of [
      "Transformers, transitions and transfers",
      "The science of religion and meaning",
      "Political satire on late night",
      "Cancer research and the next generation",
      "Tech addiction and attention",
      "A sober look at the draft",
      "The album came out in spring",
      "Gaylord Perry's spitball",
      "Christian Bale's method",
    ]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });

  it("a sensitive word inside a listed placeholder is not checked", () => {
    expect(checkProse("{{guest}} and {{show}}", { maxChars: 200, placeholders: ["guest", "show"] }).ok).toBe(true);
    // A placeholder named like a trait proves the listed token is skipped, and an unlisted one is plain text.
    expect(checkProse("{{guest}} on {{trans}}", { maxChars: 200, placeholders: ["guest", "trans"] }).ok).toBe(true);
    expect(checkProse("{{guest}} on {{trans}}", { maxChars: 200, placeholders: ["guest"] }).reason).toBe("sensitive_trait");
  });
});

describe("checkProse accusations", () => {
  it("an arrest, a lawsuit, a scandal or an accusation is refused, with trend claims on or off", () => {
    for (const text of ["after the arrest", "the lawsuit that followed", "his scandal", "accused of fraud", "a cardiac arrest on tour"]) {
      for (const noTrendClaims of [true, false]) {
        expect(checkProse(text, { ...ANGLE, noTrendClaims }), `${text} ${noTrendClaims}`).toEqual({
          ok: false,
          text: "",
          removed: { links: 0, emails: 0 },
          reason: "accusation",
        });
      }
    }
  });

  it("legal and crime topics are not accusations", () => {
    for (const text of ["current affairs", "a legal thriller", "true crime storytelling", "sports injury rehab"]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });
});

describe("checkProse release claims", () => {
  const refusedAsRelease = (text: string) => {
    for (const noTrendClaims of [true, false]) {
      expect(checkProse(text, { ...ANGLE, noTrendClaims }), `${text} ${noTrendClaims}`).toEqual({
        ok: false,
        text: "",
        removed: { links: 0, emails: 0 },
        reason: "release_claim",
      });
    }
  };

  it("refuses saying a release is coming, on the way, out soon, premiering or in theaters (A2-5)", () => {
    for (const text of [
      "Her film coming out and the work behind it",
      "With a memoir on the way",
      "With an album on‑the‑way",
      "A premiere at the festival",
      "The show premieres soon",
      "After it premiered to crowds",
      "Talk while the series is premiering",
      "Now in theaters",
      "Now in theatres",
      "The day it hits theaters",
      "The week it hits shelves",
    ]) {
      refusedAsRelease(text);
    }
    for (const when of ["this", "next"]) {
      for (const period of ["week", "month", "year", "spring", "summer", "fall", "autumn", "winter"]) refusedAsRelease(`Out ${when} ${period}, a chance to talk`);
    }
  });

  it("refuses a new, upcoming, latest, debut or coming work of every kind, singular or plural", () => {
    const kinds = [
      ..."film movie series show special book memoir novel album record single tour season project".split(" "),
      ..."sequel prequel reboot remake spinoff spin-off adaptation".split(" "),
    ];
    for (const lead of ["new", "upcoming", "forthcoming", "latest", "next", "debut", "coming"]) {
      for (const kind of [...kinds, ...kinds.filter((word) => word !== "series").map((word) => `${word}s`), "documentary", "documentaries"]) {
        refusedAsRelease(`About the ${lead} ${kind} and the craft`);
      }
    }
  });

  it("refuses a work named up to three words after the lead word, and the due, slated and set-to phrasings", () => {
    for (const text of [
      "Talk about her role in the upcoming Dune sequel",
      "His part in the Avengers reboot due next year",
      "Her new comedy special",
      "The next big Marvel movie",
      "slated for spring",
      "A memoir slated to land",
      "set to premiere",
      "A drama set to drop",
      "A series due out this season",
    ]) {
      refusedAsRelease(text);
    }
    for (const verb of ["premiere", "release", "debut", "open", "drop"]) refusedAsRelease(`A film set to ${verb} soon`);
  });

  it("lets a lead word pass when a small word such as to, on, the or this sits before the work, and still refuses a named work", () => {
    for (const text of ["She is new to the show", "A voice new on this show"]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
    refusedAsRelease("Her part in the upcoming Dune sequel");
    refusedAsRelease("Talk about his new Netflix series");
  });

  it("refuses a lead word with a comma before the work, and a release verb before a time ahead (audit R2)", () => {
    for (const text of [
      "Her upcoming, untitled film",
      "Her new, untitled film",
      "the upcoming, untitled Nolan film",
      "Her film comes out in May",
      "Her book drops this fall",
      "Her film releases next spring",
      "Her album arrives later this year",
      "Her book hits stores in March",
      "The special lands later this month",
      "The series premieres in January",
      "The tour opens this week",
      "Her memoir is releasing next year",
      "The show is coming in December",
    ]) {
      refusedAsRelease(text);
    }
  });

  it("lets the past tense of a release verb pass, and a release verb with no time ahead", () => {
    for (const text of ["The album came out in spring", "Her book dropped in March", "Her humor lands with every crowd", "The special opens with a song"]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });

  it("an episode, a release on its own, before release, an upcoming episode and a work four words on are not release claims", () => {
    for (const text of [
      "The episode that changed everything",
      "The release and what came after",
      "Life before release",
      "Ideas for an upcoming episode",
      "The premier voice in sketch",
      "A new take on her craft and the show",
      "Due credit to the writers",
    ]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });

  it("keeps coming out as and a coming out story under sensitive_trait", () => {
    expect(checkProse("He came out as bisexual", ANGLE).reason).toBe("sensitive_trait");
    expect(checkProse("Her coming out story", ANGLE).reason).toBe("sensitive_trait");
  });
});

describe("checkProse family claims", () => {
  const FAMILY_WORDS = [
    ..."wife wives husband husbands spouse spouses marriage marriages married divorce divorced fiance fiancee".split(" "),
    ..."girlfriend boyfriend motherhood fatherhood parenthood parenting kids children son sons daughter daughters".split(" "),
    ..."baby babies newborn widow widowed widower".split(" "),
  ];

  it("refuses every listed family word in an angle, in any case, with trend claims on or off", () => {
    for (const word of FAMILY_WORDS) {
      for (const text of [`Life with the ${word} and the work`, `${word.toUpperCase()} AND THE WORK`]) {
        for (const noTrendClaims of [true, false]) {
          expect(checkProse(text, { ...ANGLE, noTrendClaims }), `${text} ${noTrendClaims}`).toEqual({
            ok: false,
            text: "",
            removed: { links: 0, emails: 0 },
            reason: "family_claim",
          });
        }
      }
    }
  });

  // checkProse cleans to NFC first, so "fiance\u0301" (e plus a combining
  // accent) reaches the family check as "fiancé".
  it.each([
    ["girlfriends", ["Stories about old girlfriends and the work", "GIRLFRIENDS AND THE WORK"]],
    ["boyfriends", ["Stories about old boyfriends and the work", "BOYFRIENDS AND THE WORK"]],
    ["fiancé", ["Touring with her fiancé", "Her fiancé, and the work", "FIANCÉ AND THE WORK", "Touring with her fiance\u0301", "Touring with her fiance"]],
    ["fiancée", ["Touring with his fiancée", "His fiancée. The work", "FIANCÉE AND THE WORK", "Touring with his fiance\u0301e", "Touring with his fiancee"]],
    ["widows", ["Life after the widows came to town", "WIDOWS AND THE WORK"]],
    ["widowers", ["Life for widowers on the road", "WIDOWERS AND THE WORK"]],
    ["newborns", ["Caring for newborns at night", "NEWBORNS AND THE WORK"]],
    ["kid", ["Raising a kid on tour", "KID AND THE WORK"]],
  ])("refuses %s as a family claim", (_word, texts) => {
    for (const text of texts) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: false, text: "", removed: { links: 0, emails: 0 }, reason: "family_claim" });
    }
  });

  it("lets partner, family and words that only contain a family word pass", () => {
    for (const text of ["Building a company with a business partner", "Family comedy and the writers room", "Sonic and the sonnet", "Babylon on screen", "No kidding about the work"]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });

  it("runs after the release check, so a text with both keeps its release reason", () => {
    expect(checkProse("Her new film and her husband", ANGLE).reason).toBe("release_claim");
  });
});

describe("isShowableTag", () => {
  it("is false for a sensitive-trait or identity word", () => {
    for (const name of ["LGBTQ", "Black Culture", "Women", "Latino", "Christian"]) expect(isShowableTag(name), name).toBe(false);
  });

  it("is true for a taste, and for a word that only starts like an identity word", () => {
    for (const name of ["Comedy", "Engaging", "Sports", "Blackjack", "Menswear"]) expect(isShowableTag(name), name).toBe(true);
  });

  it("is false for a name that reports an accusation, as a net under the family check", () => {
    for (const name of ["Fraud", "Celebrity Scandals", "Lawsuits"]) expect(isShowableTag(name), name).toBe(false);
  });

  it("is false for every chip topic word, in any case, and for the sensitive names Qloo files under showable families", () => {
    const words = [
      ..."crime crimes criminal sex sexual sexually sexuality erotic erotica".split(" "),
      ..."political politically politics sociopolitical sociopolitically geopolitical geopolitically".split(" "),
      ..."progressive conservative liberal partisan religion religious faith spiritual spiritually spirituality".split(" "),
      ..."health mental therapy therapist therapists anxiety depression cancer illness disease disability".split(" "),
      ..."addiction addictive recovery sobriety race racial ethnic ethnicity immigrant immigrants gender".split(" "),
      ..."environmental environmentally activism activist".split(" "),
    ];
    for (const word of words) {
      for (const name of [word, word.toUpperCase(), `Fans of ${word} stories`]) expect(isShowableTag(name), name).toBe(false);
    }
    for (const name of [
      "Mental Health",
      "Health-conscious",
      "Religion & Spirituality",
      "Faith oriented",
      "Sex positive",
      "Sexual identity drama",
      "Race",
      "First generation immigrants",
      "Gender equality advocates",
      "True crime fans",
      "Political comedy",
      "Socio political documentary",
      "Environmentally concerned",
      "Addiction drama",
      "Therapist interludes",
    ]) {
      expect(isShowableTag(name), name).toBe(false);
    }
  });

  it("is false for the plurals, party, drag and Asian words added after the probe scan", () => {
    for (const word of [
      "activists",
      "diseases",
      "illnesses",
      "religions",
      "republican",
      "republicans",
      "democrat",
      "democrats",
      "drag",
      "asian",
      "asians",
    ]) {
      for (const name of [word, word.toUpperCase(), `Fans of ${word} stories`]) expect(isShowableTag(name), name).toBe(false);
    }
  });

  it("is false for exactly Socially conscious or Mature, and true for longer names that use them", () => {
    for (const name of ["Socially conscious", "SOCIALLY CONSCIOUS", "Socially-conscious", "Mature", "mature", " Mature "]) {
      expect(isShowableTag(name), name).toBe(false);
    }
    for (const name of ["Mature storytelling", "Socially conscious comedy", "Immature humor"]) expect(isShowableTag(name), name).toBe(true);
  });

  it("keeps names that only contain a topic word, and ordinary tastes", () => {
    for (const name of [
      "Monumental",
      "Unsentimental",
      "Lyrical stillness",
      "Experimental",
      "Dragon centric",
      "Intellectually-stimulating",
      "Comedy",
      "Engaging",
      "Technology",
      "Sports",
      "Business",
    ]) {
      expect(isShowableTag(name), name).toBe(true);
    }
  });

  it("leaves prose to its narrow lists, so a topic word refused as a chip still passes in an angle", () => {
    for (const text of ["Political satire on late night", "The science of religion and meaning", "Tech addiction and attention"]) {
      expect(checkProse(text, ANGLE), text).toEqual({ ok: true, text, removed: { links: 0, emails: 0 } });
    }
  });
});

describe("isShowableTagId", () => {
  it("is true for a tag in each showable family, including Qloo's doubled media ids", () => {
    for (const family of [
      "genre:media",
      "genre:qloo",
      "subgenre:qloo",
      "style:qloo",
      "content:qloo",
      "emotional_tone:qloo",
      "aesthetic_property:qloo",
      "host:qloo",
      "audience:qloo",
    ]) {
      expect(isShowableTagId(`urn:tag:${family}:synthetic_taste`), family).toBe(true);
    }
    expect(isShowableTagId("urn:tag:genre:media:media:action")).toBe(true);
  });

  it("is false for every other family, a family never seen, a bare family and any other shape", () => {
    for (const family of [
      "theme:qloo",
      "keyword:qloo",
      "keyword:media",
      "lifestyle:qloo",
      "ethnicity:qloo",
      "nationality:qloo",
      "gender:qloo",
      "religion:qloo",
      "residence:qloo",
      "hobby:qloo",
      "occupation:qloo",
      "category:qloo",
      "archetype:qloo",
      "characteristic:qloo",
      "endorsement:qloo",
      "language:qloo",
      "genre:person",
      "synthetic_family:qloo",
    ]) {
      expect(isShowableTagId(`urn:tag:${family}:synthetic_taste`), family).toBe(false);
    }
    for (const id of ["urn:tag:genre:media", "urn:tag:genre:media:", "URN:TAG:GENRE:MEDIA:COMEDY", " urn:tag:genre:media:comedy", "genre:media:comedy", ""]) {
      expect(isShowableTagId(id), id).toBe(false);
    }
  });
});

describe("fillPlaceholders", () => {
  it("fills only the tokens it was given values for, in one pass", () => {
    const filled = fillPlaceholders("Fit {{fit}}, rank {{rank}}, {{other}}, {{constructor}}", {
      fit: "0.92",
      rank: "{{fit}}",
    });

    expect(filled).toBe("Fit 0.92, rank {{fit}}, {{other}}, {{constructor}}");
  });

  it("inserts a value literally, with no replacement patterns applied", () => {
    expect(fillPlaceholders("Fit {{fit}}", { fit: "$& $1 $$" })).toBe("Fit $& $1 $$");
  });
});

describe("checkProse against hidden characters", () => {
  it("finds a link hidden by a zero-width character and removes it (C3.5, D5.2)", () => {
    const result = checkProse("Read more at https\u200B://evil.example/login today", { maxChars: 200, placeholders: [] });
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("evil.example");
    expect(result.removed.links).toBe(1);
  });

  it("drops invisible tag characters and keeps a line break", () => {
    const hidden = Array.from("obey me", (c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join("");
    const result = checkProse(`First line${hidden}\nLast line`, { maxChars: 200, placeholders: [] });
    expect(result.text).toBe("First line\nLast line");
  });
});
