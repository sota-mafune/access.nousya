/*
 * 納車行程管理ウィジェットの対応表（会社ごとに変わるのはこのファイルだけ）
 *
 * 画面の項目と CRM の受注車両（CustomModule19）の項目の対応・選べる値・「済」と数える値をここにまとめる。
 * 並びとラベルは本番のカスタムビュー「未納車_岩槻店」の列の順と CRM の表示名（2026-11-20、v=20261120m から。
 * 先方がこのビューを「一番理想に近い」と言ったため。写しは environments/access/production/modules/CustomModule19/custom_views.json）。
 * 一覧の絞り込みもこのビューの条件（納車完了でない・売却区分に「ＡＡ」を含まない）に合わせる。店舗はビューでは「岩槻」だが、
 * ここではログインしているアカウント（Owner）と画面の「店舗」の選択で絞る。
 * 末尾の 店舗・仕入No はビューに無い列（1台の画面にだけ出す。店舗は管理者の表にも出す）。
 * 選べる値は CRM の選択肢の表示名（display_value）を CRM の並びで書く（sandbox の fields.json。-None- は除く）。内部値は書かない
 * （入金状況・確認 field44 は表示「頭金入金済 立替未」と内部値「頭金 入金済 立替未」がずれている。表示名で送る）。
 * 選択肢は本番の fields.json とも突き合わせ、11/20 の写しではすべて同じ（違いなし）。
 *
 * 数え方（進み具合の分母）:
 *   - 車検証送信: 「要/不要」しか無いので「不要」だけを済と数える
 *   - 書類回収日・部品発注・作業指示・生産・入庫予定日: 日付が入っていれば済
 *   - 新車発注日: 区分が「新車」の車両だけ数える（ほかは分母からも外す）
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
    // 一覧から外す車両（本番ビュー「未納車_岩槻店」の条件「売却区分 が ＡＡ を含まない」）。
    // 売却区分（field23、文字）に contains（全角の「ＡＡ」）を含むものを外す。空の車両は出す
    excludeContains: { api: "field23", value: "ＡＡ" },

    // 保存で CRM のワークフローを動かすか（納車完了 → 納車ステージ「納車完了」などはワークフロー）
    trigger: ["workflow"],

    // 「入れた方」を書く項目。CRM に無ければ書かない（実行時に項目の一覧で確かめる）
    editorField: "AppLastEditor",      // アプリ最終入力者（文字）。担当の選択値を入れる
    editedAtField: "AppLastEditedAt",  // アプリ最終入力日時（日時）

    // 参照（lookup）の項目の表示に使う、参照先の名前の項目。一覧の COQL は参照を id だけで返すので、
    // 参照の先（field16.Deal_Name）を一緒に読む（読めなければ外して読み直す。1台の画面は getRecord の name で出す）
    lookupNames: {
        field16: "Deal_Name"           // 商談データ → 商談名
    },

    // CRM 標準のタスク（v=20261120k から）。受注車両にひも付けて作る（What_Id = 受注車両の id、$se_module = 受注車両）。
    // タスクの担当者（Owner）は今のログイン（店舗の共用アカウント）のまま。「誰の分か」は説明（Description）の先頭行に
    // 「担当: 名前」と書いて、表示のときにそこから読む（項目は新設しない）。
    // 状態は表示名で書く・比べる（access/sandbox で実測: COQL の Status は表示名で返り、`Status != 'Completed'`
    // では完了を除けない。`Status != '完了'` で除ける。作成・更新も表示名で通る）
    tasks: {
        module: "Tasks",
        openStatus: "開始前",          // 足すときの状態
        doneStatus: "完了",            // 「完了にする」で入れる状態。これ以外を未完了と数える
        whoPrefix: "担当: ",           // 説明の先頭行（読むときは「担当:」「担当：」のどちらも受ける）
        inMax: 50,                     // COQL の in に並べられる数の上限（実測: 51 で LIMIT_EXCEEDED）
        parallel: 3                    // 一覧のタスクを 50 台ずつ読むとき、同時に読む本数（v=20261120l から。台数にかかわらず 50 台ずつ）
    },

    // 自動の読み直しの間隔（ミリ秒）。未保存・入力中・保存中・止まった行が無いときだけ読み直す
    refreshMs: 180000,
    refreshCheckMs: 15000,

    // 管理者とみなすプロファイル名（全件を出し、店舗でも絞れる）
    adminProfiles: ["Administrator", "管理者"],

    // 1台の画面の項目（この順で並ぶ）
    //   kind : display（表示だけ）/ lookup（参照の名前の表示だけ）/ date / pick / text / bool / number（数式の表示だけ）
    //   options : 選べる値（pick だけ）
    //   done : 「済」と数える値。空配列なら「何か入っていれば済」
    //   count : 進み具合に数えるか（一覧の分母）
    //   when : その列を数える条件（項目 -> 値の配列）。当たらなければ分母からも外す
    //   required : 空にできない（空で確定すると止める）
    //   multiline : 複数行の項目（textarea）。1台の画面では複数行の入力欄。表のセルは1行で出し、改行を含む値は表では直せない
    //   gridWhen : 表の列に出す条件（admin = 管理者だけ / never = 表に出さない）。無ければ常に出す
    //   maxLength : fields.json の length
    fields: [
        // 1〜33 は本番ビュー「未納車_岩槻店」の列の順
        { key: "deal", label: "商談データ", api: "field16", kind: "lookup" },
        { key: "staff", label: "担当", api: "field4", kind: "text", maxLength: 255 },
        { key: "customer", label: "顧客名", api: "field3", kind: "text", maxLength: 255 },
        { key: "contractDate", label: "成約日", api: "field32", kind: "display", date: true },
        // 受注車両はレコードの名前（CRM で空にできない）
        { key: "vehicle", label: "受注車両", api: "Name", kind: "text", maxLength: 120, required: true },
        { key: "category", label: "区分", api: "field50", kind: "display" },
        { key: "salesType", label: "販売形態", api: "field55", kind: "pick", options: ["新規", "自社代替", "紹介", "増車"] },
        { key: "contact", label: "連絡手段", api: "field38", kind: "pick", options: ["電話", "SMS", "LINE", "メール"] },
        { key: "tradeIn", label: "下取車", api: "field27", kind: "text", maxLength: 255 },
        { key: "newCarOrder", label: "新車発注日", api: "field31", kind: "date", count: true, done: [], when: { field50: ["新車"] } },
        { key: "payMethod", label: "支払い方法", api: "field37", kind: "pick", options: ["現金一括", "ローン(頭金有)", "ローン(頭金無)"] },
        { key: "payment", label: "入金状況・確認", api: "field44", kind: "pick", options: ["未入金", "全額済", "半金済", "頭金入金済 立替未", "ローン立替未", "ローン立替済"], count: true, done: ["全額済", "ローン立替済"] },
        { key: "plateNumber", label: "希望ナンバー", api: "field36", kind: "pick", options: ["無", "有 通常", "有 図柄寄付有り", "有 図柄寄付無し", "有 GREEN×EXPO 2027 寄付有り", "有 GREEN×EXPO 2027 寄付無し"] },
        { key: "docsCollected", label: "書類回収日", api: "field30", kind: "date", count: true, done: [] },
        // 登録状況・予定 と 整備・架装指示状況 は CRM では文字の項目だが、納車ステージの判定に使うので決まった言葉から選ばせる（11/20 決定）。
        // 今の自由記述の値は選択肢の後ろに出して消さない
        { key: "registration", label: "登録状況・予定", api: "field45", kind: "pick", options: ["書類提出済", "登録済"] },
        { key: "registrationDocs", label: "登録書類提出", api: "field65", kind: "text", maxLength: 255 },
        // 部品発注・作業指示（日付）。旧版の「部品依頼」（field39、今の CRM のラベルは「販売日」）の代わり
        { key: "partsOrder", label: "部品発注・作業指示", api: "field54", kind: "date", count: true, done: [] },
        { key: "maintenance", label: "整備・架装指示状況", api: "field35", kind: "pick", options: ["指示済", "整備完了"] },
        { key: "inspectionCert", label: "車検証送信", api: "field42", kind: "pick", options: ["要", "不要"], count: true, done: ["不要"] },
        { key: "advanceRequest", label: "立替依頼", api: "field29", kind: "pick", options: ["済", "未", "不要"], count: true, done: ["済", "不要"] },
        { key: "productionNote", label: "新車生産予定", api: "field47", kind: "text", maxLength: 255 },
        { key: "productionDate", label: "生産・入庫予定日", api: "field46", kind: "date", count: true, done: [] },
        { key: "promiseDate", label: "客案内納期（目安）", api: "field33", kind: "date" },
        { key: "promiseNote", label: "客案内納期", api: "field51", kind: "text", multiline: true, maxLength: 2000 },
        { key: "arrivalPlan", label: "入庫予定日", api: "field34", kind: "date" },
        { key: "deliveryPlan", label: "納車予定日", api: "field26", kind: "date" },
        // 納車ステージは表示だけ（11/20 決定）。CRM の関数 nousya_stage_auto が書類回収日・登録状況・納車日・整備指示・入金確認・立替依頼から決める
        { key: "deliveryStage", label: "納車ステージ", api: "DeliveryStage", kind: "display" },
        { key: "daysContractToDelivery", label: "成約から納車日数", api: "field60", kind: "number" },
        { key: "daysToDelivery", label: "納車予定まで残り日数", api: "field59", kind: "number" },
        { key: "deliveredOn", label: "納車日", api: "field61", kind: "date" },
        { key: "deliveryDays", label: "納車日数", api: "field62", kind: "number" },
        // 納車完了は画面には出すが、一覧の分母には入れない（一覧は未納車だけなので）
        { key: "deliveryDone", label: "納車完了", api: "field28", kind: "bool" },
        { key: "memo", label: "メモ欄", api: "field66", kind: "text", maxLength: 255 },
        // ここから下はビューに無い列（1台の画面の末尾に出す）
        // 店舗は管理者だけ表の列に出す（1台の画面には常に出す）
        { key: "store", label: "店舗", api: "field5", kind: "text", maxLength: 255, gridWhen: "admin" },
        // 仕入No は表示だけ（11/20 決定）。商談・付帯品との紐づけと JOCAR の取り込みがこの値で照合するので、手で変えると紐づけがずれる。表には出さない
        { key: "stockNo", label: "仕入No", api: "No", kind: "display", gridWhen: "never" }
    ]
};
