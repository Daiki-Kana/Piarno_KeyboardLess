/**
 * Web Audio API を用いた低遅延アコースティックピアノ風シンセエンジン
 * 外部音声ファイルに頼らず、加算合成・動的倍音フィルター・急峻アタックエンベロープにより
 * 立ち上がりの自然なピアノ音色を生成します。
 */

export class PianoSynth {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  constructor() {
    // AudioContext の生成は遅延可能（ブラウザの Autoplay Policy に準拠）
  }

  /**
   * AudioContext の初期化および再開（ユーザー操作イベント内で呼び出し必須）
   */
  public async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtxClass();

      // 音割れ防止・クリッピング抑制用のリミッター（コンプレッサー）
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-6, this.ctx.currentTime);
      this.compressor.knee.setValueAtTime(4, this.ctx.currentTime);
      this.compressor.ratio.setValueAtTime(12, this.ctx.currentTime);
      this.compressor.attack.setValueAtTime(0.002, this.ctx.currentTime);
      this.compressor.release.setValueAtTime(0.1, this.ctx.currentTime);

      // マスターゲイン
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.8, this.ctx.currentTime);

      this.compressor.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    return this.ctx;
  }

  /**
   * 複数周波数の和音（コード伴奏）を同時に発音
   * @param frequencies 和音を構成する周波数の配列 (Hz)
   * @param velocity 打鍵強度
   */
  public async playChord(frequencies: number[], velocity: number = 0.8): Promise<void> {
    const scaledVel = velocity * 0.72;
    await Promise.all(frequencies.map((freq) => this.playNote(freq, scaledVel)));
  }

  /**
   * 指定した周波数のピアノ音を低遅延で発音
   * @param frequency 発音周波数 (Hz)
   * @param velocity 打鍵強度 (0.0 ~ 1.0)
   */
  public async playNote(frequency: number, velocity: number = 0.8): Promise<void> {
    const ctx = await this.ensureContext();
    const now = ctx.currentTime;

    // 0.05 ~ 1.0 の範囲にクランプ
    const vel = Math.max(0.05, Math.min(1.0, velocity));

    // 音長（低音ほど長く、高音ほど短い自然な弦の減衰）
    const duration = Math.max(1.2, Math.min(2.8, 2.5 * Math.pow(261.63 / frequency, 0.3)));

    // ノート全体のゲインノード
    const noteGain = ctx.createGain();
    noteGain.connect(this.compressor!);

    // エンベロープ設計（急峻なアタック 3ms + 指数関数的ディケイ）
    const peakGain = 0.5 * Math.pow(vel, 1.2);
    noteGain.gain.setValueAtTime(0.0001, now);
    // 3msでピークまで立ち上げ（クリックノイズを防ぎつつ鋭い打弦を表現）
    noteGain.gain.linearRampToValueAtTime(peakGain, now + 0.003);
    // 指数関数的減衰（ピアノ弦特有のロングサステイン・ディケイ）
    noteGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    // 動的ローパスフィルター（打鍵強弱による音色変化とアタック時の高域強調）
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(1.8, now);

    const baseCutoff = Math.max(frequency * 1.5, 400);
    // 打鍵が強いほど高次倍音が開放される
    const peakCutoff = Math.min(14000, frequency * (3 + vel * 7));

    filter.frequency.setValueAtTime(peakCutoff, now);
    // アタック直後（80ms）でフィルターが急速に閉じ、落ち着いた余韻へ移行
    filter.frequency.exponentialRampToValueAtTime(baseCutoff, now + Math.min(duration * 0.4, 0.45));
    filter.connect(noteGain);

    // --- 倍音オシレーター構成 ---
    // 1. 基本波 (Sine): 芯のある澄んだ低中域
    const oscFundamental = ctx.createOscillator();
    oscFundamental.type = 'sine';
    oscFundamental.frequency.setValueAtTime(frequency, now);

    // 2. ピアノ弦の厚み・微小なうなりを再現するデチューン波 (Triangle)
    const oscDetune = ctx.createOscillator();
    oscDetune.type = 'triangle';
    oscDetune.frequency.setValueAtTime(frequency, now);
    oscDetune.detune.setValueAtTime(3.5, now); // +3.5 cents のうなり

    // 3. 2倍音 (Sine): 明るさとアコースティック弦の響き
    const oscHarmonic2 = ctx.createOscillator();
    oscHarmonic2.type = 'sine';
    oscHarmonic2.frequency.setValueAtTime(frequency * 2, now);

    // 各オシレーターのバランス調整ゲイン
    const gainFundamental = ctx.createGain();
    gainFundamental.gain.setValueAtTime(0.8, now);

    const gainDetune = ctx.createGain();
    gainDetune.gain.setValueAtTime(0.4, now);

    const gainHarmonic2 = ctx.createGain();
    // 2倍音は打鍵強度に応じて強調
    gainHarmonic2.gain.setValueAtTime(0.3 * vel, now);

    oscFundamental.connect(gainFundamental);
    oscDetune.connect(gainDetune);
    oscHarmonic2.connect(gainHarmonic2);

    gainFundamental.connect(filter);
    gainDetune.connect(filter);
    gainHarmonic2.connect(filter);

    // --- ハンマー打撃ノイズ/アタックトランジェント ---
    // 打鍵直後の20msだけごく微小なアタックパルスを加えて鍵盤のコツッという打撃感を付加
    const oscHammer = ctx.createOscillator();
    oscHammer.type = 'sine';
    oscHammer.frequency.setValueAtTime(frequency * 4.5, now);
    const gainHammer = ctx.createGain();
    gainHammer.gain.setValueAtTime(0.25 * vel, now);
    gainHammer.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);

    oscHammer.connect(gainHammer);
    gainHammer.connect(filter);

    // オシレーター起動
    const stopTime = now + duration + 0.05;
    oscFundamental.start(now);
    oscDetune.start(now);
    oscHarmonic2.start(now);
    oscHammer.start(now);

    oscFundamental.stop(stopTime);
    oscDetune.stop(stopTime);
    oscHarmonic2.stop(stopTime);
    oscHammer.stop(now + 0.03);

    // 終了後にノードを切断してメモリ解放
    setTimeout(() => {
      try {
        oscFundamental.disconnect();
        oscDetune.disconnect();
        oscHarmonic2.disconnect();
        oscHammer.disconnect();
        gainFundamental.disconnect();
        gainDetune.disconnect();
        gainHarmonic2.disconnect();
        gainHammer.disconnect();
        filter.disconnect();
        noteGain.disconnect();
      } catch {
        // すでに切断されている場合は無視
      }
    }, (duration + 0.1) * 1000);
  }
}
