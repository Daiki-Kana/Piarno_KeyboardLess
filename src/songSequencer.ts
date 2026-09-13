/**
 * マイペース型楽曲シーケンサー
 * 打鍵トリガー（ユーザー入力）が来るまで自動では進まず、
 * 1音ずつ確実に演奏を待機・進行させるシーケンサーモジュール。
 */

export interface NoteInfo {
  pitch: string;      // 例: "C4", "C5"
  solfege: string;    // 例: "ド", "ソ"
  frequency: number;  // 周波数 (Hz)
  chord?: readonly number[]; // 和音構成周波数の配列 (Hz) - 左手コード伴奏用
  durationBeats?: number; // 拍数（表示用）
  hand?: 'Left' | 'Right'; // パート種別
}

export interface SongData {
  id: string;
  title: string;
  notes: NoteInfo[];
}

// 代表的な音階の基本周波数定数 (A4 = 440Hz, 低音域〜中高音域まで網羅)
export const NOTE_FREQS = {
  // 低音域 (Octave 3)
  C3: 130.81,
  D3: 146.83,
  E3: 164.81,
  F3: 174.61,
  G3: 196.00,
  A3: 220.00,
  B3: 246.94,

  // 中音域 (Octave 4 - 左手伴奏に最適な明瞭なミドル帯)
  C4: 261.63,
  D4: 293.66,
  E4: 329.63,
  F4: 349.23,
  G4: 392.00,
  A4: 440.00,
  B4: 493.88,

  // 高音域 (Octave 5 & 6 - メロディが美しく響くハイ帯)
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  F5: 698.46,
  G5: 783.99,
  A5: 880.00,
  B5: 987.77,
  C6: 1046.50,
} as const;

// 左手コード伴奏の構成音 (ピアノの基本和音)
export const CHORDS = {
  // Cメジャー和音 (ド・ミ・ソ: C4, E4, G4)
  C: [NOTE_FREQS.C4, NOTE_FREQS.E4, NOTE_FREQS.G4],
  // Fメジャー和音 (ド・ファ・ラ: C4, F4, A4)
  F: [NOTE_FREQS.C4, NOTE_FREQS.F4, NOTE_FREQS.A4],
  // Gメジャー和音 (シ・レ・ソ: B3, D4, G4)
  G: [NOTE_FREQS.B3, NOTE_FREQS.D4, NOTE_FREQS.G4],
  // Aマイナー和音 (ド・ミ・ラ: C4, E4, A4)
  Am: [NOTE_FREQS.C4, NOTE_FREQS.E4, NOTE_FREQS.A4],
  // C/E和音 (ド・ミ・ソ: C4, E4, G4)
  Em: [NOTE_FREQS.C4, NOTE_FREQS.E4, NOTE_FREQS.G4],
} as const;

/**
 * テスト楽曲: きらきら星 (Twinkle Twinkle Little Star - 単音版)
 */
export const TWINKLE_STAR: SongData = {
  id: 'twinkle_star',
  title: 'きらきら星',
  notes: [
    // 1行目: ド ド ソ ソ ラ ラ ソ
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4 },
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4 },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4 },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4 },
    { pitch: 'A4', solfege: 'ラ', frequency: NOTE_FREQS.A4 },
    { pitch: 'A4', solfege: 'ラ', frequency: NOTE_FREQS.A4 },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, durationBeats: 2 },

    // 2行目: ファ ファ ミ ミ レ レ ド
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4 },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4 },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4 },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4 },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4 },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4 },
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4, durationBeats: 2 },

    // 3行目: ソ ソ ファ ファ ミ ミ レ
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4 },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4 },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4 },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4 },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4 },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4 },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4, durationBeats: 2 },

    // 4行目: ソ ソ ファ ファ ミ ミ レ
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4 },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4 },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4 },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4 },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4 },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4 },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4, durationBeats: 2 },

    // 5行目: ド ド ソ ソ ラ ラ ソ
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4 },
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4 },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4 },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4 },
    { pitch: 'A4', solfege: 'ラ', frequency: NOTE_FREQS.A4 },
    { pitch: 'A4', solfege: 'ラ', frequency: NOTE_FREQS.A4 },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, durationBeats: 2 },

    // 6行目: ファ ファ ミ ミ レ レ ド
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4 },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4 },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4 },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4 },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4 },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4 },
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4, durationBeats: 2 },
  ],
};

/**
 * 本格両手協調版: きらきら星 (左右交互ハンドシェア奏法)
 * 1音ごとに左手と右手が交互にメロディ（同一オクターブ C4〜A4）を受け持ち、
 * 誰でも交互に打鍵するだけで自然で美しい「きらきら星」が途切れず流れます。
 */
export const TWINKLE_STAR_TWO_HANDS: SongData = {
  id: 'twinkle_star_two_hands',
  title: 'きらきら星 (両手交互)',
  notes: [
    // 1行目: き・ら・き・ら・ひ・か・る (ド ド ソ ソ ラ ラ ソー)
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4, hand: 'Left' },
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4, hand: 'Right' },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, hand: 'Left' },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, hand: 'Right' },
    { pitch: 'A4', solfege: 'ラ', frequency: NOTE_FREQS.A4, hand: 'Left' },
    { pitch: 'A4', solfege: 'ラ', frequency: NOTE_FREQS.A4, hand: 'Right' },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, durationBeats: 2, hand: 'Right' },

    // 2行目: お・そ・ら・の・ほ・し・よ (ファ ファ ミ ミ レ レ ドー)
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4, hand: 'Left' },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4, hand: 'Right' },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4, hand: 'Left' },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4, hand: 'Right' },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4, hand: 'Left' },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4, hand: 'Right' },
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4, durationBeats: 2, hand: 'Right' },

    // 3行目: ま・ば・た・き・し・て・は (ソ ソ ファ ファ ミ ミ レー)
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, hand: 'Left' },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, hand: 'Right' },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4, hand: 'Left' },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4, hand: 'Right' },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4, hand: 'Left' },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4, hand: 'Right' },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4, durationBeats: 2, hand: 'Right' },

    // 4行目: み・ん・な・を・み・て・る (ソ ソ ファ ファ ミ ミ レー)
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, hand: 'Left' },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, hand: 'Right' },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4, hand: 'Left' },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4, hand: 'Right' },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4, hand: 'Left' },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4, hand: 'Right' },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4, durationBeats: 2, hand: 'Right' },

    // 5行目: き・ら・き・ら・ひ・か・る (ド ド ソ ソ ラ ラ ソー)
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4, hand: 'Left' },
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4, hand: 'Right' },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, hand: 'Left' },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, hand: 'Right' },
    { pitch: 'A4', solfege: 'ラ', frequency: NOTE_FREQS.A4, hand: 'Left' },
    { pitch: 'A4', solfege: 'ラ', frequency: NOTE_FREQS.A4, hand: 'Right' },
    { pitch: 'G4', solfege: 'ソ', frequency: NOTE_FREQS.G4, durationBeats: 2, hand: 'Right' },

    // 6行目: お・そ・ら・の・ほ・し・よ (ファ ファ ミ ミ レ レ ドー)
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4, hand: 'Left' },
    { pitch: 'F4', solfege: 'ファ', frequency: NOTE_FREQS.F4, hand: 'Right' },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4, hand: 'Left' },
    { pitch: 'E4', solfege: 'ミ', frequency: NOTE_FREQS.E4, hand: 'Right' },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4, hand: 'Left' },
    { pitch: 'D4', solfege: 'レ', frequency: NOTE_FREQS.D4, hand: 'Right' },
    { pitch: 'C4', solfege: 'ド', frequency: NOTE_FREQS.C4, durationBeats: 2, hand: 'Right' },
  ],
};

export class SongSequencer {
  private currentSong: SongData;
  private currentIndex: number = 0;

  constructor(initialSong: SongData = TWINKLE_STAR_TWO_HANDS) {
    this.currentSong = initialSong;
    this.currentIndex = 0;
  }

  /**
   * 現在演奏待機中の音符情報を取得
   */
  public getCurrentNote(): NoteInfo {
    return this.currentSong.notes[this.currentIndex];
  }

  /**
   * 次の予告音符（存在すれば）を取得
   */
  public getNextNote(): NoteInfo | null {
    const nextIdx = (this.currentIndex + 1) % this.currentSong.notes.length;
    return this.currentSong.notes[nextIdx] || null;
  }

  /**
   * 現在のインデックス位置 (0-based)
   */
  public getCurrentIndex(): number {
    return this.currentIndex;
  }

  /**
   * 楽曲全体の音符数
   */
  public getTotalNotes(): number {
    return this.currentSong.notes.length;
  }

  /**
   * 現在の曲名を取得
   */
  public getSongTitle(): string {
    return this.currentSong.title;
  }

  /**
   * 打鍵トリガー時に呼び出し、現在の音符を返した上でインデックスを1つ進める
   * 末尾に到達した場合は先頭に戻る
   */
  public advance(): { playedNote: NoteInfo; nextNote: NoteInfo } {
    const playedNote = this.currentSong.notes[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.currentSong.notes.length;
    const nextNote = this.currentSong.notes[this.currentIndex];
    return { playedNote, nextNote };
  }

  /**
   * シーケンサーを先頭にリセット
   */
  public reset(): void {
    this.currentIndex = 0;
  }

  /**
   * 演奏曲を切り替える
   */
  public setSong(song: SongData): void {
    this.currentSong = song;
    this.currentIndex = 0;
  }
}
