/*
 * 納車行程管理ウィジェットの対応表（会社ごとに変わるのはこのファイルだけ）
 *
 * 画面の項目と CRM の受注車両（CustomModule19）の項目の対応・選べる値・「済」と数える値をここにまとめる。
 * 並びは先方の成約車管理表（1担当者のタブ）の列の順。中身は Creator 版（environments/mgc/delivery-app/ の dlv_config）と同じ。
 * 選べる値は CRM の選択肢の表示名（display_value）を CRM の並びで書く。内部値は書かない
 * （入金状況・確認 field44 は表示「頭金入金済 立替未」と内部値「頭金 入金済 立替未」がずれている。表示名で送る）。
 *
 * 未決（先方と決める。README「人が決めること」）。決まったらこの表の該当行だけを直す:
 *   - 部品依頼: field39（今の CRM のラベルは「販売日」。選択肢 実施済/未実施）に当てている
 *   - 備考: field66（メモ欄、1行）に当てている。field51（今のラベル「客案内納期」、複数行）にする案もある
 *   - 生産予定・入庫予定: 文字 field47 にメモ、日付 field46 に予定日（案A）。案B は field47 と 入庫予定日 field34
 *   - 車検証送信: 「要/不要」しか無いので「不要」だけを済と数える
 *   - 保険加入: 何か選ばれていれば済（× も済）
 *   - 書類回収日: 「未定」は空として扱う
 *   - 新車発注: 区分が「新車」の車両だけ数える（ほかは分母からも外す）
 */
var NOUSYA_CONFIG = {
    module: "CustomModule19",          // 受注車両
    moduleLabel: "受注車両",
    // 一覧の絞り込みと並び
    ownerField: "Owner",               // ログインしているアカウントが担当（受注車両の担当者）
    staffField: "field4",              // 担当（文字）。画面の上の「担当」の選択欄で絞る
    storeField: "field5",              // 店舗（文字）。管理者のときだけ選択欄を出す
    doneField: "field28",              // 納車完了（チェック）。オンでないものを一覧に出す
    planField: "field26",              // 納車予定日。一覧はこれの近い順（空は後ろ）
    customerField: "field3",           // 顧客名
    vehicleField: "Name",              // 受注車両（車種）
    categoryField: "field50",          // 区分

    // 保存で CRM のワークフローを動かすか（納車完了 → 納車ステージ「納車完了」などはワークフロー）
    trigger: ["workflow"],

    // 「入れた方」を書く項目。CRM に無ければ書かない（実行時に項目の一覧で確かめる）
    editorField: "AppLastEditor",      // アプリ最終入力者（文字）。担当の選択値を入れる
    editedAtField: "AppLastEditedAt",  // アプリ最終入力日時（日時）

    // 保険トス（受注車両には無い。紐づく商談から読んで表示だけ）
    deal: {
        lookupField: "field16",        // 商談データ（参照）
        module: "Deals",
        tossField: "field20",          // 保険トス（日付）
        naField: "field154"            // 保険トス対象外（チェック）
    },

    // 自動の読み直しの間隔（ミリ秒）。未保存・入力中・保存中・止まった行が無いときだけ読み直す
    refreshMs: 180000,
    refreshCheckMs: 15000,

    // 管理者とみなすプロファイル名（全件を出し、店舗でも絞れる）
    adminProfiles: ["Administrator", "管理者"],

    // 1台の画面の項目（この順で並ぶ）
    //   kind : display（表示だけ）/ date / pick / text / bool / number（数式の表示だけ）/ toss（商談の保険トス）
    //   options : 選べる値（pick だけ）
    //   done : 「済」と数える値。空配列なら「何か入っていれば済」
    //   count : 進み具合に数えるか（一覧の分母）
    //   when : その列を数える条件（項目 -> 値の配列）。当たらなければ分母からも外す
    //   required : 空にできない（空で確定すると止める）
    //   gridWhen : 表の列に出す条件（allStaff = 担当を「すべて」にしているか管理者 / admin = 管理者）。無ければ常に出す
    fields: [
        { key: "customer", label: "お客様名", api: "field3", kind: "text", maxLength: 255 },
        // 車種は受注車両の名前（CRM で空にできない）
        { key: "vehicle", label: "車種", api: "Name", kind: "text", maxLength: 120, required: true },
        // 担当は「すべての担当」を出しているときと管理者だけ、店舗は管理者だけ表の列に出す（1台の画面には常に出す）
        { key: "staff", label: "担当", api: "field4", kind: "text", maxLength: 255, gridWhen: "allStaff" },
        { key: "store", label: "店舗", api: "field5", kind: "text", maxLength: 255, gridWhen: "admin" },
        // 仕入No は重複不可（同じ値があると CRM が保存を断る）。JOCAR の取り込みはこの値で既存の車両を上書きする
        { key: "stockNo", label: "仕入NO", api: "No", kind: "text", maxLength: 255 },
        { key: "deliveryStage", label: "納車ステージ", api: "DeliveryStage", kind: "pick", options: ["登録書類待ち", "登録提出", "登録済み", "納車日確定待ち", "納車整備完了", "納車準備完了", "納車完了"] },
        { key: "category", label: "区分", api: "field50", kind: "display" },
        { key: "newCarOrder", label: "新車発注", api: "field31", kind: "date", count: true, done: [], when: { field50: ["新車"] } },
        { key: "contractDate", label: "成約日", api: "field32", kind: "display", date: true },
        { key: "docsCollected", label: "書類回収日", api: "field30", kind: "date", count: true, done: [] },
        { key: "productionNote", label: "生産・入庫予定（メモ）", api: "field47", kind: "text", maxLength: 255 },
        { key: "productionDate", label: "生産・入庫予定日", api: "field46", kind: "date", count: true, done: [] },
        { key: "deliveryPlan", label: "納車日", api: "field26", kind: "date", note: "納車予定日" },
        { key: "insuranceToss", label: "保険トス", api: "", kind: "toss" },
        { key: "insuranceJoin", label: "保険加入", api: "field58", kind: "pick", options: ["既契約車両入替", "〇", "×"], count: true, done: [] },
        { key: "payment", label: "入金確認", api: "field44", kind: "pick", options: ["未入金", "全額済", "半金済", "頭金入金済 立替未", "ローン立替未", "ローン立替済"], count: true, done: ["全額済", "ローン立替済"] },
        { key: "registration", label: "登録課", api: "field45", kind: "text", maxLength: 255 },
        { key: "partsRequest", label: "部品依頼", api: "field39", kind: "pick", options: ["実施済", "未実施"], count: true, done: ["実施済"] },
        { key: "advanceRequest", label: "立替依頼", api: "field29", kind: "pick", options: ["済", "未", "不要"], count: true, done: ["済", "不要"] },
        { key: "maintenance", label: "整備指示書", api: "field35", kind: "text", maxLength: 255 },
        { key: "inspectionCert", label: "車検証送信", api: "field42", kind: "pick", options: ["要", "不要"], count: true, done: ["不要"] },
        { key: "daysContractToDelivery", label: "成約→納車日数", api: "field60", kind: "number" },
        { key: "daysToDelivery", label: "納車予定まで残り日数", api: "field59", kind: "number" },
        // 納車完了は画面には出すが、一覧の分母には入れない（一覧は未納車だけなので）
        { key: "deliveryDone", label: "納車完了", api: "field28", kind: "bool" },
        { key: "memo", label: "備考", api: "field66", kind: "text", maxLength: 255 }
    ]
};
