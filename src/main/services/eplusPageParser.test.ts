import { describe, expect, it } from "vitest";
import { parseEplusPage } from "./eplusPageParser.js";

describe("Eplus page parser", () => {
  it("extracts standard detail page metadata and options", () => {
    const parsed = parseEplusPage(
      "https://eplus.jp/sf/detail/0534530001-P0030221P021001?P1=0175",
      `
      <html><head>
        <title>LiSA(2027/1/30(土)) - イープラス</title>
        <link rel="canonical" href="https://eplus.jp/sf/detail/0534530001">
        <meta property="og:title" content="LiSA(2027/1/30(土)) - イープラス">
      </head><body>
        <h1 class="s4-main-title">LiSA (岐阜県・2027/1/30(土))</h1>
        <article class="block-ticket">
          <p>プレオーダー 受付中</p>
          <a href="/sf/detail/0534530001-P0030221P021001">申込み</a>
          <p>4枚まで</p>
        </article>
        <script type="application/ld+json">
          {"@context":"http://schema.org","@type":"Event","name":"LiSA","startDate":"2027-01-30T17:45","location":{"@type":"Place","name":"長良川国際会議場メインホール"}}
        </script>
      </body></html>
      `
    );

    expect(parsed.title).toContain("LiSA");
    expect(parsed.venue).toBe("長良川国際会議場メインホール");
    expect(parsed.rawFormSchema.sourceKind).toBe("standard-detail");
    expect(parsed.rawFormSchema.applicationLinks).toHaveLength(1);
    expect(parsed.rawFormSchema.quantityRange?.max).toBe(4);
  });

  it("detects serial-code pages and known error handling hints", () => {
    const parsed = parseEplusPage(
      "https://eplus.jp/sf/detail/3035790001?P6=993",
      `
      <html><head><title>LoveLive! Series 15th Anniversary ラブライブ！フェス - イープラス</title></head>
      <body>
        <h1 class="page-header__title">LoveLive! Series 15th Anniversary ラブライブ！フェス<br>＜Day.1＞ラブライブ！先行抽選</h1>
        <p>※枚数制限：『シリアルNo.』1つにつき、それぞれ4枚までお申込み可能</p>
        <a href="/serial/day1">＜Day.1＞お申込み</a>
        <input type="text" placeholder="シリアルナンバー">
        <button>お申込みへ</button>
        <div name="ninsho_key_whole_error_info"><p>申し込み情報が正しくありません。</p></div>
      </body></html>
      `
    );

    expect(parsed.rawFormSchema.sourceKind).toBe("serial-code");
    expect(parsed.rawFormSchema.serialCode.required).toBe(true);
    expect(parsed.rawFormSchema.serialCode.placeholder).toBe("シリアルナンバー");
    expect(parsed.rawFormSchema.applicationLinks[0]?.sessionName).toBe("Day.1");
    expect(parsed.rawFormSchema.quantityRange?.max).toBe(4);
  });
});
