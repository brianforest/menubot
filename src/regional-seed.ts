/** One curated regional→Taiwan culinary wording mapping. `region` is the
 *  provenance of the VARIANT (metadata only); `note` records why it is safe to
 *  include. Only unambiguous variants belong here — see the EXCLUDED list. */
export interface RegionalVariant {
  variant: string;
  canonical: string;
  region: string; // "hk" | "cn" | "sg"
  note: string;
}

/** Conservative starter set. Grow by appending rows (each must be unambiguous in
 *  a Taiwan-targeted menu). Loaded into the regional_variant table via INSERT OR
 *  IGNORE, so editing a row in the db is never clobbered by this seed. */
export const REGIONAL_SEED: RegionalVariant[] = [
  { variant: "芝士", canonical: "起司", region: "hk", note: "cheese" },
  { variant: "三文魚", canonical: "鮭魚", region: "hk", note: "salmon" },
  { variant: "忌廉", canonical: "鮮奶油", region: "hk", note: "cream" },
  { variant: "沙律", canonical: "沙拉", region: "hk", note: "salad" },
  { variant: "雲呢拿", canonical: "香草", region: "hk", note: "vanilla" },
  { variant: "薯仔", canonical: "馬鈴薯", region: "hk", note: "potato" },
  { variant: "意大利粉", canonical: "義大利麵", region: "hk", note: "pasta; longer than 意大利" },
  { variant: "意大利麵", canonical: "義大利麵", region: "cn", note: "simplified-region 意 form → 義" },
  { variant: "車厘子", canonical: "櫻桃", region: "hk", note: "cherry" },
  { variant: "士多啤梨", canonical: "草莓", region: "hk", note: "strawberry" },
  { variant: "青口", canonical: "淡菜", region: "hk", note: "mussel" },
  { variant: "布冧", canonical: "李子", region: "hk", note: "plum" },
  { variant: "西紅柿", canonical: "番茄", region: "cn", note: "tomato; unambiguous" },
];

/** Deliberately EXCLUDED ambiguous variants — do NOT add these to the seed:
 *  - 土豆  : Taiwan=peanut, Mainland=potato. Auto-rewrite would mislead.
 *  - 意粉  : short; collision/partial-match risk (covered by 意大利粉 instead).
 *  - 銀鱈魚→圓鱈 : possible species conflation (sablefish vs toothfish); re-add only with a verified Taiwan source.
 */
