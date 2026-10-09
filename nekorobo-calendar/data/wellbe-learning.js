// ウェルビーラーニング 年間研修計画（同梱データ）
//
// スプレッドシート連携（config.js の apiUrl）が使えないときの予備。連携中はスプレッドシートの内容が優先される。
//   fiscalYear : 年度（4月始まり・西暦。例: 2026 = 令和8年度）
//   months     : 月ごとの研修。items[0] = 研修項目①（必須研修）、items[1] = 研修項目②
//                theme = 研修項目、video = 視聴内容（ウェルビーラーニングの動画名）
window.WELLBE_SCHEDULE = [
  {
    fiscalYear: 2025, // 令和7年度（12月から開始）
    months: [
      { month: 12, items: [
        { theme: '身体拘束', video: '身体拘束廃止に向けての５ステップ' },
        { theme: '介護予防', video: '自立支援について' },
      ] },
      { month: 1, items: [
        { theme: '虐待防止', video: '虐待を防止するための取り組みについて(２)' },
        { theme: '訪問介護', video: '訪問介護でできること・できないこと１' },
      ] },
      { month: 2, items: [
        { theme: 'BCP', video: '地震対策' },
        { theme: '訪問介護', video: '訪問介護でできること・できないこと２' },
      ] },
      { month: 3, items: [
        { theme: '感染症対策', video: '健康管理と環境管理' },
        { theme: '介護保険の歴史', video: '介護保険導入の背景' },
      ] },
    ],
  },
  {
    fiscalYear: 2026, // 令和8年度
    months: [
      { month: 4, items: [
        { theme: '医療事故防止研修', video: '【1】医療事故防止の基礎知識' },
        { theme: 'コンプライアンスと個人情報', video: '【2】個人情報保護法について①' },
      ] },
      { month: 5, items: [
        { theme: 'BCP対策【災害】', video: '【3】自然災害BCPの基礎知識2' },
        { theme: 'BCP対策【災害】', video: '【4】自然災害BCPの基礎知識3' },
      ] },
      { month: 6, items: [
        { theme: '接遇・マナー研修', video: '【1】介護職における気遣いや心配り' },
        { theme: '熱中症対策', video: '【2】熱中症の方の対応' },
      ] },
      { month: 7, items: [
        { theme: '感染症対策研修', video: '【3】健康管理と環境管理' },
        { theme: '緊急時の対応', video: '【1】基本原則と心構え' },
      ] },
      { month: 8, items: [
        { theme: '身体拘束', video: '【5】身体拘束を行う場合の条件' },
        { theme: 'アドラー心理学を活用した支援', video: '【1】基本概念と障害福祉への応用' },
      ] },
      { month: 9, items: [
        { theme: '虐待防止', video: '【3】虐待発見時の対応について' },
        { theme: '認知症研修', video: '【2】認知症研修　認知症の方との関わり方①' },
      ] },
      { month: 10, items: [
        { theme: 'BCP対策【災害】', video: '【24】自然災害BCP 机上訓練ケーススタディ［訪問介護編］前編' },
        { theme: 'BCP対策【災害】', video: '【25】自然災害BCP 机上訓練ケーススタディ［訪問介護編］後編' },
      ] },
      { month: 11, items: [
        { theme: '感染症対策研修', video: '【4】標準予防策についての正しい知識や方法' },
        { theme: 'ヒヤリハット研修', video: '【1】事故発生時の対応' },
      ] },
      { month: 12, items: [
        { theme: '身体拘束', video: '【6】身体拘束に関するガイダンス' },
        { theme: '食中毒研修', video: '【1】食中毒の原因（1）' },
      ] },
      { month: 1, items: [
        { theme: '虐待防止', video: '【4】虐待防止体制' },
        { theme: 'ハラスメント', video: '【4】パワーハラスメント' },
      ] },
      { month: 2, items: [
        { theme: 'BCP【感染症】', video: '【13】感染症災害BCPの基礎知識1' },
        { theme: '緊急時の対応', video: '【1】基本原則と心構え' },
      ] },
      { month: 3, items: [
        { theme: '感染症対策', video: '【5】保健所との連携' },
        { theme: '倫理と法令遵守', video: '【1】倫理の基礎と重要性' },
      ] },
    ],
  },
];
