import { describe, expect, it } from "vitest";
import { parseApplicationRecords, parseCreditCards, parseLotteryResults, parseMemberProfile } from "./eplusMemberPageParser.js";

describe("eplus member page parser", () => {
  it("reads profile fields and only card metadata", () => {
    const html = `<dl><dt>氏名</dt><dd>山田 太郎</dd><dt>性別</dt><dd>男性</dd></dl><div data-credit-card data-card-brand="Visa" data-card-last4="1234">hidden</div><p>Mastercard ****5678</p>`;
    expect(parseMemberProfile(html)).toMatchObject({ name: "山田 太郎", gender: "男性" });
    expect(parseCreditCards(html).map((card) => ({ brand: card.brand, last4: card.last4 }))).toEqual([{ brand: "Visa", last4: "1234" }, { brand: "Mastercard", last4: "5678" }]);
  });

  it("maps table rows into applications and lottery states", () => {
    const html = `<table><thead><tr><th>公演名</th><th>申込日時</th><th>券種</th><th>枚数</th><th>当落</th><th>支払期限</th></tr></thead><tbody><tr><td>Concert</td><td>2026-07-21</td><td>指定席</td><td>2</td><td>当選</td><td>2026-07-25</td></tr><tr><td>Another</td><td>2026-07-20</td><td>一般</td><td>1</td><td>落選</td><td></td></tr></tbody></table>`;
    const applications = parseApplicationRecords(html);
    const results = parseLotteryResults(html);
    expect(applications).toHaveLength(2);
    expect(applications[0]).toMatchObject({ eventTitle: "Concert", quantity: 2, status: "当選" });
    expect(results).toMatchObject([{ eventTitle: "Concert", resultKind: "中選", paymentDeadline: "2026-07-25" }, { eventTitle: "Another", resultKind: "落選" }]);
  });
});
