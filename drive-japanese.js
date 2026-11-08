// Japanese listen-and-repeat for Drive. One sentence family at a time.
// Each item is a whole polite sentence plus one English meaning of that sentence.
// There is no word dictionary, no romaji, and no particle glossary.
// The model line is spoken on the device in Japanese. This module does not call xAI.

export const JAPANESE_SPEECH_LANG = 'ja-JP';
export const JAPANESE_SPEECH_RATE = 0.95;
// Acoustic slices use this label so coaching never names a Japanese word as a gloss.
export const JAPANESE_MEASURE_LABEL = 'the phrase';
export const JAPANESE_VOICE_MISSING = 'No Japanese woman\'s voice is available on this phone, so the sentence was not spoken.';

const MALE_JA = /otoya|ichiro|kenji|daichi|\bmale\b|男/i;
const FEMALE_JA = /kyoko|kyouko|nanami|haruka|ayumi|mizuki|sayaka|sakura|hana|o-ren|oren|\bfemale\b|女/i;

export function containsJapaneseScript(text) {
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(String(text || ''));
}

export function isJapaneseVoice(voice) {
  const lang = String(voice?.lang || '').toLowerCase().replace(/_/g, '-');
  return lang === 'ja' || lang.startsWith('ja-');
}

/** A feminine ja-JP voice when the device has one. A known male voice is not used. */
export function pickJapaneseVoice(voices = []) {
  const ja = (Array.isArray(voices) ? voices : []).filter(isJapaneseVoice);
  if (!ja.length) return null;
  const female = ja.filter(voice => FEMALE_JA.test(voice?.name || '') && !MALE_JA.test(voice?.name || ''));
  const pool = female.length ? female : ja.filter(voice => !MALE_JA.test(voice?.name || ''));
  if (!pool.length) return null;
  return pool.find(voice => voice.default) || pool[0];
}

function normalizeJapanese(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u30a1-\u30f6]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .replace(/[\s\u3000。、．，,.!！?？「」『』（）()・ー〜～-]/g, '')
    .toLowerCase();
}

/**
 * Whether a transcript is the same sentence. 'unknown' when recognition
 * returned nothing. A mismatch is not a vocabulary lesson.
 */
export function japaneseRepeatMatch(expected, heard) {
  const want = normalizeJapanese(expected);
  const said = normalizeJapanese(heard);
  if (!want || !said) return 'unknown';
  if (!containsJapaneseScript(heard)) return 'mismatch';
  if (said === want || (want.length >= 4 && (said.includes(want) || want.includes(said)))) return 'match';
  const seen = new Set(want);
  let hit = 0;
  for (const char of said) if (seen.has(char)) hit += 1;
  const overlap = hit / Math.max(said.length, want.length);
  if (overlap >= 0.72 && said.length >= Math.min(4, want.length)) return 'match';
  return 'mismatch';
}

/** Voiced time a short Japanese sentence usually takes, so a mid-line breath does not end the take. */
export function expectedJapaneseVoicedMs(sentence) {
  const count = String(sentence || '').replace(/\s/g, '').length;
  if (!count) return 0;
  return Math.min(9000, Math.max(800, count * 160 + 180));
}

export const JAPANESE_FAMILIES = [
  {
    id: 'drinks',
    items: [
      { jp: '水を飲みます。', en: 'I drink water.' },
      { jp: 'お茶を飲みます。', en: 'I drink tea.' },
      { jp: 'コーヒーを飲みます。', en: 'I drink coffee.' },
      { jp: '牛乳を飲みます。', en: 'I drink milk.' },
      { jp: 'ジュースを飲みます。', en: 'I drink juice.' },
      { jp: '水を飲みました。', en: 'I drank water.' },
      { jp: 'コーヒーを飲みません。', en: 'I don\'t drink coffee.' },
      { jp: 'お茶を飲みますか。', en: 'Do you drink tea?' }
    ]
  },
  {
    id: 'meals',
    items: [
      { jp: 'ごはんを食べます。', en: 'I eat rice.' },
      { jp: 'パンを食べます。', en: 'I eat bread.' },
      { jp: 'りんごを食べます。', en: 'I eat an apple.' },
      { jp: 'サラダを食べます。', en: 'I eat salad.' },
      { jp: 'ごはんを食べました。', en: 'I ate rice.' },
      { jp: 'パンを食べました。', en: 'I ate bread.' },
      { jp: '肉を食べません。', en: 'I don\'t eat meat.' },
      { jp: '魚を食べますか。', en: 'Do you eat fish?' }
    ]
  },
  {
    id: 'going',
    items: [
      { jp: '駅に行きます。', en: 'I go to the station.' },
      { jp: '店に行きます。', en: 'I go to the store.' },
      { jp: '公園に行きます。', en: 'I go to the park.' },
      { jp: '会社に行きます。', en: 'I go to work.' },
      { jp: '駅に行きました。', en: 'I went to the station.' },
      { jp: '店に行きました。', en: 'I went to the store.' },
      { jp: '今日は行きません。', en: 'I\'m not going today.' },
      { jp: '公園に行きますか。', en: 'Are you going to the park?' }
    ]
  },
  {
    id: 'liking',
    items: [
      { jp: '猫が好きです。', en: 'I like cats.' },
      { jp: '犬が好きです。', en: 'I like dogs.' },
      { jp: '音楽が好きです。', en: 'I like music.' },
      { jp: '映画が好きです。', en: 'I like movies.' },
      { jp: '春が好きです。', en: 'I like spring.' },
      { jp: '紅茶が好きでした。', en: 'I used to like black tea.' },
      { jp: '冬は好きではありません。', en: 'I don\'t like winter.' },
      { jp: '犬は好きですか。', en: 'Do you like dogs?' }
    ]
  },
  {
    id: 'weather',
    items: [
      { jp: '今日は晴れです。', en: 'It\'s sunny today.' },
      { jp: '今日は雨です。', en: 'It\'s rainy today.' },
      { jp: '今日は曇りです。', en: 'It\'s cloudy today.' },
      { jp: '今日は暑いです。', en: 'It\'s hot today.' },
      { jp: '今日は寒いです。', en: 'It\'s cold today.' },
      { jp: '昨日は雨でした。', en: 'It was rainy yesterday.' },
      { jp: '今日は寒くないです。', en: 'It\'s not cold today.' },
      { jp: '明日は晴れですか。', en: 'Will it be sunny tomorrow?' }
    ]
  },
  {
    id: 'time',
    items: [
      { jp: '今、七時です。', en: 'It\'s seven o\'clock now.' },
      { jp: '今、三時です。', en: 'It\'s three o\'clock now.' },
      { jp: '今、十時です。', en: 'It\'s ten o\'clock now.' },
      { jp: '朝の六時です。', en: 'It\'s six in the morning.' },
      { jp: '夜の八時です。', en: 'It\'s eight at night.' },
      { jp: 'さっき五時でした。', en: 'It was five o\'clock a little while ago.' },
      { jp: 'まだ六時ではありません。', en: 'It\'s not six o\'clock yet.' },
      { jp: '今、四時ですか。', en: 'Is it four o\'clock now?' }
    ]
  },
  {
    id: 'morning',
    items: [
      { jp: '朝、起きます。', en: 'I get up in the morning.' },
      { jp: '朝、顔を洗います。', en: 'I wash my face in the morning.' },
      { jp: '朝、歯を磨きます。', en: 'I brush my teeth in the morning.' },
      { jp: '朝ごはんを食べます。', en: 'I eat breakfast.' },
      { jp: '朝、起きました。', en: 'I got up in the morning.' },
      { jp: '歯を磨きました。', en: 'I brushed my teeth.' },
      { jp: '週末は早く起きません。', en: 'I don\'t get up early on weekends.' },
      { jp: '朝、歯を磨きますか。', en: 'Do you brush your teeth in the morning?' }
    ]
  },
  {
    id: 'around',
    items: [
      { jp: '机の上に本があります。', en: 'There is a book on the desk.' },
      { jp: 'かばんの中に鍵があります。', en: 'There is a key in the bag.' },
      { jp: '部屋に猫がいます。', en: 'There is a cat in the room.' },
      { jp: '公園に犬がいます。', en: 'There is a dog in the park.' },
      { jp: '机の上に本がありました。', en: 'There was a book on the desk.' },
      { jp: '駅の前に店があります。', en: 'There is a shop in front of the station.' },
      { jp: '部屋に猫はいません。', en: 'There isn\'t a cat in the room.' },
      { jp: 'かばんに水がありますか。', en: 'Is there water in the bag?' }
    ]
  },
  {
    id: 'want',
    items: [
      { jp: '水が欲しいです。', en: 'I want water.' },
      { jp: '新しい靴が欲しいです。', en: 'I want new shoes.' },
      { jp: 'コーヒーが飲みたいです。', en: 'I want to drink coffee.' },
      { jp: '家に帰りたいです。', en: 'I want to go home.' },
      { jp: '映画が見たいです。', en: 'I want to see a movie.' },
      { jp: '昨日はお茶が欲しかったです。', en: 'I wanted tea yesterday.' },
      { jp: '今は何も欲しくないです。', en: 'I don\'t want anything right now.' },
      { jp: '公園に行きたいですか。', en: 'Do you want to go to the park?' }
    ]
  },
  {
    id: 'feelings',
    items: [
      { jp: '今日は元気です。', en: 'I feel well today.' },
      { jp: '今日は楽しいです。', en: 'I\'m enjoying today.' },
      { jp: 'ちょっと疲れています。', en: 'I\'m a little tired.' },
      { jp: '今日は忙しいです。', en: 'I\'m busy today.' },
      { jp: '今は眠いです。', en: 'I\'m sleepy now.' },
      { jp: '昨日は暇でした。', en: 'I was free yesterday.' },
      { jp: '今日は忙しくないです。', en: 'I\'m not busy today.' },
      { jp: '元気ですか。', en: 'Are you well?' }
    ]
  },
  {
    id: 'transport',
    items: [
      { jp: '電車で行きます。', en: 'I go by train.' },
      { jp: 'バスで行きます。', en: 'I go by bus.' },
      { jp: '歩いて行きます。', en: 'I go on foot.' },
      { jp: '車で行きます。', en: 'I go by car.' },
      { jp: '自転車で行きます。', en: 'I go by bicycle.' },
      { jp: '昨日は電車で行きました。', en: 'I went by train yesterday.' },
      { jp: '今日は車では行きません。', en: 'I\'m not going by car today.' },
      { jp: 'バスで行きますか。', en: 'Are you going by bus?' }
    ]
  },
  {
    id: 'shopping',
    items: [
      { jp: '水を買います。', en: 'I buy water.' },
      { jp: 'パンを買います。', en: 'I buy bread.' },
      { jp: '切符を買います。', en: 'I buy a ticket.' },
      { jp: 'この本を買います。', en: 'I\'ll buy this book.' },
      { jp: 'パンを買いました。', en: 'I bought bread.' },
      { jp: '花を買いました。', en: 'I bought flowers.' },
      { jp: '切符を買いません。', en: 'I\'m not buying a ticket.' },
      { jp: 'コーヒーを買いますか。', en: 'Are you buying coffee?' }
    ]
  },
  {
    id: 'work',
    items: [
      { jp: '今日は働きます。', en: 'I work today.' },
      { jp: '今日は勉強します。', en: 'I study today.' },
      { jp: '家で勉強します。', en: 'I study at home.' },
      { jp: '図書館で勉強します。', en: 'I study at the library.' },
      { jp: '昨日は働きました。', en: 'I worked yesterday.' },
      { jp: '夜に勉強しました。', en: 'I studied at night.' },
      { jp: '今日は働きません。', en: 'I\'m not working today.' },
      { jp: '明日も勉強しますか。', en: 'Will you study tomorrow too?' }
    ]
  },
  {
    id: 'people',
    items: [
      { jp: '友達に会います。', en: 'I meet a friend.' },
      { jp: '家族に会います。', en: 'I see my family.' },
      { jp: '先生に会います。', en: 'I meet my teacher.' },
      { jp: '駅で友達に会います。', en: 'I meet a friend at the station.' },
      { jp: '昨日、友達に会いました。', en: 'I met a friend yesterday.' },
      { jp: 'カフェで友達に会いました。', en: 'I met a friend at a cafe.' },
      { jp: '今日は誰にも会いません。', en: 'I\'m not meeting anyone today.' },
      { jp: '週末に家族に会いますか。', en: 'Will you see your family this weekend?' }
    ]
  },
  {
    id: 'tomorrow',
    items: [
      { jp: '明日、駅に行きます。', en: 'I\'m going to the station tomorrow.' },
      { jp: '明日、友達に会います。', en: 'I\'m meeting a friend tomorrow.' },
      { jp: '明日、映画を見ます。', en: 'I\'m seeing a movie tomorrow.' },
      { jp: '明日、家で休みます。', en: 'I\'m resting at home tomorrow.' },
      { jp: '昨日、映画を見ました。', en: 'I saw a movie yesterday.' },
      { jp: '昨日は家で休みました。', en: 'I rested at home yesterday.' },
      { jp: '明日は行きません。', en: 'I\'m not going tomorrow.' },
      { jp: '明日、早く起きますか。', en: 'Are you getting up early tomorrow?' }
    ]
  },
  {
    id: 'where',
    items: [
      { jp: '今、家にいます。', en: 'I\'m at home now.' },
      { jp: '今、駅にいます。', en: 'I\'m at the station now.' },
      { jp: '今、会社にいます。', en: 'I\'m at work now.' },
      { jp: '今、カフェにいます。', en: 'I\'m at a cafe now.' },
      { jp: 'さっきまで家にいました。', en: 'I was at home until a little while ago.' },
      { jp: '昨日は公園にいました。', en: 'I was at the park yesterday.' },
      { jp: '今日は会社にいません。', en: 'I\'m not at work today.' },
      { jp: '今、どこにいますか。', en: 'Where are you now?' }
    ]
  },
  {
    id: 'reasons',
    items: [
      { jp: '雨なので、家にいます。', en: 'It\'s raining, so I\'m at home.' },
      { jp: '暑いので、水を飲みます。', en: 'It\'s hot, so I drink water.' },
      { jp: '疲れているので、休みます。', en: 'I\'m tired, so I\'m resting.' },
      { jp: '寒いので、コートを着ます。', en: 'It\'s cold, so I wear a coat.' },
      { jp: '暇なので、本を読みます。', en: 'I\'m free, so I read a book.' },
      { jp: '雨だったので、家にいました。', en: 'It was raining, so I was at home.' },
      { jp: '忙しいので、行きません。', en: 'I\'m busy, so I\'m not going.' },
      { jp: '明日は晴れるので、公園に行きますか。', en: 'It will be sunny tomorrow, so are you going to the park?' }
    ]
  },
  {
    id: 'often',
    items: [
      { jp: '毎日、水を飲みます。', en: 'I drink water every day.' },
      { jp: 'よく音楽を聞きます。', en: 'I often listen to music.' },
      { jp: 'ときどき映画を見ます。', en: 'I sometimes watch movies.' },
      { jp: '週末はよく公園に行きます。', en: 'I often go to the park on weekends.' },
      { jp: 'いつも電車で行きます。', en: 'I always go by train.' },
      { jp: '昨日も勉強しました。', en: 'I studied yesterday too.' },
      { jp: 'あまり肉を食べません。', en: 'I don\'t eat meat very often.' },
      { jp: 'いつも電車で行きますか。', en: 'Do you always go by train?' }
    ]
  }
];

const MEANINGS = new Map();
for (const family of JAPANESE_FAMILIES) {
  for (const item of family.items) MEANINGS.set(item.jp, item.en);
}

export function japaneseLines() {
  return JAPANESE_FAMILIES.flatMap(family => family.items.map(item => item.jp));
}

export function japaneseMeaning(sentence) {
  return MEANINGS.get(sentence) || '';
}

export function japanesePlace(index) {
  const families = JAPANESE_FAMILIES.length;
  let cursor = 0;
  for (let family = 0; family < families; family += 1) {
    const variations = JAPANESE_FAMILIES[family].items.length;
    if (index < cursor + variations) {
      return { family: family + 1, families, variation: index - cursor + 1, variations };
    }
    cursor += variations;
  }
  return { family: families, families, variation: 0, variations: 0 };
}
