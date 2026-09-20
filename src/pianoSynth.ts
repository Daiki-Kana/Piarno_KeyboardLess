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
      try {
        await this.ctx.resume();
      } catch (resumeErr) {
        console.warn('AudioContext resume failed:', resumeErr);
      }
    }

    // iOS Safari / Chrome 自動再生アンロック用: ユーザー操作コンテキストで無音バッファを強制再生
    try {
      const silentBuf = this.ctx.createBuffer(1, 1, 22050);
      const source = this.ctx.createBufferSource();
      source.buffer = silentBuf;
      source.connect(this.ctx.destination);
      source.start(0);
    } catch {
      // 無音再生失敗時は無視
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
    try {
      const ctx = await this.ensureContext();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      // 0.005s (5ms) 先から開始することで、Web Audio スケジューラの先頭欠け・無音化を完全防止
      const startTime = ctx.currentTime + 0.005;
      this.renderNote(ctx, frequency, velocity, startTime);
    } catch (err) {
      console.error('[PianoSynth playNote エラー]:', err);
    }
  }

  /**
   * 指定時刻（Web Audio API クロック）における単音の物理合成・エンベロープ構築
   */
  private renderNote(
    ctx: AudioContext,
    frequency: number,
    velocity: number,
    startTime: number
  ): void {
    // 周波数が異常な場合はデフォルト（C4: 261.63Hz）にフォールバック
    const safeFreq = Number.isFinite(frequency) && frequency > 20 ? frequency : 261.63;
    const vel = Math.max(0.05, Math.min(1.0, velocity));

    // 音長（低音ほど長く、高音ほど短い自然な弦の減衰）
    const duration = Math.max(1.2, Math.min(2.8, 2.5 * Math.pow(261.63 / safeFreq, 0.3)));

    // ノート全体のゲインノード
    const noteGain = ctx.createGain();
    noteGain.connect(this.compressor!);

    // エンベロープ設計（10ms の確実な立ち上がりアタック + 指数関数的ディケイ）
    const peakGain = 0.55 * Math.pow(vel, 1.2);
    const attackTime = 0.010;
    noteGain.gain.setValueAtTime(0.0001, startTime);
    noteGain.gain.linearRampToValueAtTime(peakGain, startTime + attackTime);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    // 動的ローパスフィルター（打鍵強弱による音色変化とアタック時の高域強調）
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.setValueAtTime(1.8, startTime);

    const baseCutoff = Math.max(safeFreq * 1.5, 400);
    const peakCutoff = Math.min(14000, safeFreq * (3 + vel * 7));

    filter.frequency.setValueAtTime(peakCutoff, startTime);
    filter.frequency.exponentialRampToValueAtTime(baseCutoff, startTime + Math.min(duration * 0.4, 0.45));
    filter.connect(noteGain);

    // --- 倍音オシレーター構成 ---
    // 1. 基本波 (Sine): 芯のある澄んだ低中域
    const oscFundamental = ctx.createOscillator();
    oscFundamental.type = 'sine';
    oscFundamental.frequency.setValueAtTime(safeFreq, startTime);

    // 2. ピアノ弦の厚み・微小なうなりを再現するデチューン波 (Triangle)
    const oscDetune = ctx.createOscillator();
    oscDetune.type = 'triangle';
    oscDetune.frequency.setValueAtTime(safeFreq, startTime);
    oscDetune.detune.setValueAtTime(3.5, startTime); // +3.5 cents のうなり

    // 3. 2倍音 (Sine): 明るさとアコースティック弦の響き
    const oscHarmonic2 = ctx.createOscillator();
    oscHarmonic2.type = 'sine';
    oscHarmonic2.frequency.setValueAtTime(safeFreq * 2, startTime);

    // 各オシレーターのバランス調整ゲイン
    const gainFundamental = ctx.createGain();
    gainFundamental.gain.setValueAtTime(0.85, startTime);

    const gainDetune = ctx.createGain();
    gainDetune.gain.setValueAtTime(0.45, startTime);

    const gainHarmonic2 = ctx.createGain();
    gainHarmonic2.gain.setValueAtTime(0.35 * vel, startTime);

    oscFundamental.connect(gainFundamental);
    oscDetune.connect(gainDetune);
    oscHarmonic2.connect(gainHarmonic2);

    gainFundamental.connect(filter);
    gainDetune.connect(filter);
    gainHarmonic2.connect(filter);

    // --- ハンマー打撃ノイズ/アタックトランジェント ---
    const oscHammer = ctx.createOscillator();
    oscHammer.type = 'sine';
    oscHammer.frequency.setValueAtTime(safeFreq * 4.5, startTime);
    const gainHammer = ctx.createGain();
    gainHammer.gain.setValueAtTime(0.25 * vel, startTime);
    gainHammer.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.025);

    oscHammer.connect(gainHammer);
    gainHammer.connect(filter);

    // オシレーター起動
    const stopTime = startTime + duration + 0.05;
    oscFundamental.start(startTime);
    oscDetune.start(startTime);
    oscHarmonic2.start(startTime);
    oscHammer.start(startTime);

    oscFundamental.stop(stopTime);
    oscDetune.stop(stopTime);
    oscHarmonic2.stop(stopTime);
    // 終了後にノードを切断してメモリ解放
    const delayMs = Math.max(0, (stopTime - ctx.currentTime) + 0.3) * 1000;
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
      } catch {}
    }, delayMs);
  }
}
