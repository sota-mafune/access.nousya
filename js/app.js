/*
 * 納車行程管理ウィジェット（Zoho CRM の Web タブに置く外部ホストのウィジェット）
 *
 * ① 未納車一覧: ログインしているアカウントが担当（Owner）で、納車完了でない受注車両。納車予定が近い順。
 *    画面の上の「担当」（受注車両の 担当 field4）で絞る。選んだ担当はこの端末に覚える。管理者は全件・店舗でも絞れる。
 * ② 1台の画面: 管理表の列の順に項目を並べ、その場で入れて保存。変えた項目だけを送る。
 *    送る前に最新を読み直し、開いた後に他で変わっていれば送らない。送った後に読み戻して画面に出す。
 *
 * 項目の対応は js/config.js（NOUSYA_CONFIG）だけに書く。このファイルは会社に依らない。
 * 秘密情報・組織の id はここに書かない（必要なものは実行時に SDK で読む）。
 */
(function () {
    "use strict";

    var CFG = window.NOUSYA_CONFIG;
    var PAGE = 200;            // COQL は1回 200 件まで
    var MAX_ROWS = 4000;       // 一覧に読む上限（これを超えたら知らせる）
    var INIT_TIMEOUT_MS = 15000;

    var state = {
        user: null,
        isAdmin: false,
        fieldSet: null,        // CRM に在る項目の api_name（読めなければ null）
        rows: [],
        truncated: false,
        staff: "",             // "" = すべて
        store: "",
        listStale: false,
        listSeq: 0,            // 一覧の読み込みの連番（遅れて返った古い結果を捨てる）
        viewSeq: 0,            // 1台の画面の読み込みの連番（同じ）
        listLoading: false,
        saving: false,
        meta: {},              // 表: 行（受注車両の id）ごとの入力・保存の状態
        gridMode: false,       // 広い画面で表を出しているか
        gridView: [], gridCols: [], active: null, editing: null,
        tossInList: true,
        cur: null              // 開いている1台: { id, base, toss, values, seq }
    };

    // ---------------------------------------------------------------- 小道具
    function $(id) { return document.getElementById(id); }
    function esc(v) {
        return String(v === null || v === undefined ? "" : v)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function pad2(n) { return ("0" + n).slice(-2); }
    // 値をそろえる（空・-None- は ""、真偽はそのまま、日付・日時は文字のまま）
    function norm(v) {
        if (v === null || v === undefined) return "";
        if (typeof v === "boolean") return v;
        if (typeof v === "object") {
            if (v.name !== undefined) return String(v.name);
            if (v.id !== undefined) return String(v.id);
            return JSON.stringify(v);
        }
        var s = String(v);
        if (s === "-None-") return "";
        return s;
    }
    function normBool(v) { return v === true || v === "true"; }
    function dateOnly(v) { var s = norm(v); return typeof s === "string" ? s.slice(0, 10) : ""; }
    function todayStr() { var d = new Date(); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
    function daysBetween(fromStr, toStr) {
        var a = fromStr.split("-").map(Number), b = toStr.split("-").map(Number);
        return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
    }
    function fmtDate(v) {
        var s = dateOnly(v);
        if (!s || s.length < 10) return "";
        var p = s.split("-").map(Number);
        var w = "日月火水木金土".charAt(new Date(p[0], p[1] - 1, p[2]).getDay());
        return p[0] + "/" + p[1] + "/" + p[2] + "（" + w + "）";
    }
    function fmtDateTime(v) {
        var s = norm(v);
        if (!s) return "";
        var d = new Date(s);
        if (isNaN(d.getTime())) return s;
        return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }
    // 今の時刻を CRM の日時の形（2026-11-20T10:15:00+09:00）で
    function nowIso() {
        var d = new Date(), off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-";
        off = Math.abs(off);
        return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" +
            pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) + sign + pad2(Math.floor(off / 60)) + ":" + pad2(off % 60);
    }
    function errText(e) {
        if (!e) return "不明なエラー";
        if (typeof e === "string") return e.slice(0, 300);
        if (e.message && typeof e.message === "string") return (e.code ? e.code + ": " : "") + e.message.slice(0, 300);
        if (e.data && e.data[0] && (e.data[0].code || e.data[0].message)) return (e.data[0].code || "") + " " + (e.data[0].message || "");
        if (e.code) return String(e.code);
        try { return JSON.stringify(e).slice(0, 300); } catch (x) { return String(e); }
    }
    function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 使えなくても動く */ } }
    function byJa(a, b) { return String(a).localeCompare(String(b), "ja"); }

    function exists(api) { return !!api && (state.fieldSet === null || state.fieldSet[api] === true); }
    // 「入れた方」の項目は、在ると確かめられたときだけ書く（項目の一覧を読めなければ書かない）
    function editorReady() { return !!state.fieldSet && state.fieldSet[CFG.editorField] === true; }
    function editedAtReady() { return !!state.fieldSet && state.fieldSet[CFG.editedAtField] === true; }

    // ---------------------------------------------------------------- 表示の切り替え
    function show(viewId) {
        ["view-message", "view-list", "view-detail"].forEach(function (id) { $(id).hidden = id !== viewId; });
        window.scrollTo(0, 0);
    }
    function fatal(title, body) {
        $("message-title").textContent = title;
        $("message-body").textContent = body || "";
        show("view-message");
    }
    function setNotice(elId, kind, html) {
        var el = $(elId);
        if (!html) { el.hidden = true; el.innerHTML = ""; return; }
        el.className = "notice notice-" + kind;
        el.innerHTML = html;
        el.hidden = false;
    }

    // ---------------------------------------------------------------- 起動
    function boot() {
        var sdk = typeof window.ZOHO !== "undefined" && window.ZOHO && window.ZOHO.embeddedApp;
        var inFrame = false;
        try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }
        if (!sdk || !inFrame) {
            fatal("CRM の中で開いてください", "この画面は Zoho CRM の「納車行程管理」タブの中で使います。CRM にログインして、タブから開いてください。");
            return;
        }
        var done = false;
        setTimeout(function () {
            if (!done) $("message-body").textContent = "CRM とつながるのに時間がかかっています。タブを開き直してください（作った直後は開き直すと動くことがあります）。";
        }, INIT_TIMEOUT_MS);
        ZOHO.embeddedApp.init().then(function () {
            done = true;
            return start();
        }).catch(function (e) {
            done = true;
            fatal("CRM とつながりませんでした", errText(e));
        });
    }

    async function start() {
        $("message-body").textContent = "ログインしている方を確かめています…";
        try {
            var u = await ZOHO.CRM.CONFIG.getCurrentUser();
            state.user = u && u.users && u.users[0];
        } catch (e) {
            fatal("ログインしている方を読めませんでした", errText(e));
            return;
        }
        if (!state.user || !state.user.id) { fatal("ログインしている方を読めませんでした", ""); return; }
        var prof = state.user.profile && state.user.profile.name;
        state.isAdmin = CFG.adminProfiles.indexOf(prof) !== -1;

        await Promise.all([readEnv(), readFieldMeta()]);

        // 覚えている担当（端末ごと・アカウントごと）
        state.staff = lsGet(storageKey("staff")) || "";
        state.store = state.isAdmin ? (lsGet(storageKey("store")) || "") : "";
        $("store-wrap").hidden = !state.isAdmin;
        $("who").textContent = state.isAdmin ? "管理者（全件）" : (state.user.full_name || "") + " の担当分";
        // 「入れた方」（項目がある環境だけ）。既定は選んでいる担当
        $("grid-editor-wrap").hidden = !editorReady();
        if (state.staff && state.staff !== "__none__") $("grid-editor").value = state.staff;
        await loadList();
    }

    function storageKey(name) { return "nousya." + name + "." + (state.user ? state.user.id : ""); }

    // sandbox か本番かを画面の隅に出す（試験の入口）。組織の情報 → 親の画面の URL の順で見る
    async function readEnv() {
        var label = "", type = "";
        try {
            var o = await ZOHO.CRM.CONFIG.getOrgInfo();
            var org = o && (o.org ? o.org[0] : o);
            if (org && org.type) type = String(org.type).toLowerCase();
            if (!type && org && typeof org.sandbox !== "undefined") type = org.sandbox ? "sandbox" : "production";
        } catch (e) { /* 読めなければ URL で見る */ }
        if (!type) {
            var hint = "";
            try { hint = (window.location.ancestorOrigins && window.location.ancestorOrigins.length) ? window.location.ancestorOrigins[0] : ""; } catch (e) { hint = ""; }
            if (!hint) hint = document.referrer || "";
            if (/sandbox/i.test(hint)) type = "sandbox";
            else if (/zoho\./i.test(hint)) type = "production?";
        }
        if (type === "sandbox") label = "sandbox";
        else if (type === "production") label = "本番";
        else if (type === "production?") label = "本番?";
        else label = "環境不明";
        var el = $("env-badge");
        el.textContent = label;
        el.className = "env-badge " + (type === "sandbox" ? "env-sandbox" : (label === "環境不明" ? "env-unknown" : "env-prod"));
        el.hidden = false;
    }

    async function readFieldMeta() {
        try {
            var m = await ZOHO.CRM.META.getFields({ Entity: CFG.module });
            var list = (m && (m.fields || m.data)) || [];
            if (!list.length) return;
            var set = {};
            list.forEach(function (f) { if (f && f.api_name) set[f.api_name] = true; });
            state.fieldSet = set;
        } catch (e) {
            state.fieldSet = null; // 読めなければ対応表を信じる（「入れた方」は書かない）
        }
    }

    // ---------------------------------------------------------------- ① 一覧
    // 一覧（表）で読む項目。表にすべての列を出すので、対応表の項目を全部読む。
    // withToss: 商談の保険トスを参照の先（field16.field20 など）で一緒に読む（1台ずつ読まないため）
    function tossKeys() { var d = CFG.deal; return [d.lookupField + "." + d.tossField, d.lookupField + "." + d.naField]; }
    function listFields(withToss) {
        var want = ["id", CFG.ownerField, "Modified_Time", CFG.vehicleField, CFG.customerField, CFG.staffField, CFG.storeField,
            CFG.planField, CFG.doneField, CFG.categoryField, CFG.editorField, CFG.editedAtField];
        CFG.fields.forEach(function (f) {
            if (f.api) want.push(f.api);
            if (f.when) Object.keys(f.when).forEach(function (k) { want.push(k); });
        });
        var seen = {}, out = [];
        want.forEach(function (a) { if (a && !seen[a] && (a === "id" || exists(a))) { seen[a] = true; out.push(a); } });
        if (withToss && exists(CFG.deal.lookupField)) {
            if (!seen[CFG.deal.lookupField]) out.push(CFG.deal.lookupField);
            out = out.concat(tossKeys());
        }
        return out;
    }

    async function coqlAll(where, withToss) {
        var cols = listFields(withToss).join(", ");
        var out = [], offset = 0;
        state.truncated = false;
        while (true) {
            var q = "select " + cols + " from " + CFG.module + " where " + where + " order by id asc limit " + offset + ", " + PAGE;
            var res = await ZOHO.CRM.API.coql({ select_query: q });
            if (res && Array.isArray(res.data)) {
                out = out.concat(res.data);
                if (res.info && res.info.more_records) {
                    offset += PAGE;
                    if (offset >= MAX_ROWS) { state.truncated = true; break; }
                    continue;
                }
                break;
            }
            if (res && typeof res === "object" && (res.code || res.status === "error" || res.message)) throw res;
            // 0 件（204）と言えるのは、先頭のページで中身の無い応答が返ったときだけ。
            // 2ページ目以降で data が無いのは想定外なので、欠けた一覧を出さずに止める
            if (offset === 0 && isEmptyResponse(res)) break;
            throw new Error("一覧の応答が想定外の形でした（" + (offset / PAGE + 1) + " ページ目）");
        }
        return out;
    }
    function isEmptyResponse(res) {
        if (res === null || res === undefined || res === "") return true;
        if (typeof res !== "object") return false;
        if (res.status === 204 || res.status === "204") return true;
        return Object.keys(res).length === 0;
    }

    async function loadList() {
        var seq = ++state.listSeq;
        state.viewSeq++;          // 開きかけの1台の結果は捨てる
        state.cur = null;
        state.listLoading = true;
        show("view-list");
        setNotice("list-notice", "", "");
        $("count").textContent = "";
        $("list").innerHTML = "<div class='loading'>読み込んでいます…</div>";
        var notDone = "(" + CFG.doneField + " = false)";
        var rows;
        try {
            // 管理者は全件。ほかは担当者（Owner）で絞る。絞り込みが通らなくても全件から手元で絞ることはしない
            // （上限で切れて自分の車が黙って落ちるため）。エラーとして出す
            var where = state.isAdmin ? notDone
                : notDone + " and " + CFG.ownerField + " = '" + String(state.user.id).replace(/[^0-9]/g, "") + "'";
            state.tossInList = true;
            try {
                rows = await coqlAll(where, true);
            } catch (eToss) {
                if (seq !== state.listSeq) return;
                // 保険トス（商談の参照の先）を一緒に読めなければ、それを外して読み直す（表の保険トスの列は「—」）。
                // 行の絞り込みは同じなので、車が欠けることはない
                state.tossInList = false;
                rows = await coqlAll(where, false);
            }
        } catch (e) {
            if (seq !== state.listSeq) return;
            state.listLoading = false;
            state.listStale = true;
            $("list").innerHTML = "";
            setNotice("list-notice", "error", "一覧を読めませんでした（" + esc(errText(e)) + "）。「読み直す」を押すか、タブを開き直してください。");
            return;
        }
        if (seq !== state.listSeq) return; // 後から始まった読み込み・1台の画面がある
        state.listLoading = false;
        state.rows = rows.filter(function (r) { return !normBool(r[CFG.doneField]); });
        state.rows.forEach(function (r) { r.__gen = seq; });
        state.meta = {};          // 表の行ごとの入力・保存の状態（読み直したら空にする。未保存があれば先に画面で確かめている）
        state.listStale = false;
        fillSelectors();
        if (!state.tossInList) setNotice("list-notice", "warn", "保険トス（商談）を一覧では読めませんでした。1台の画面では表示します。");
        renderList();
    }

    function fillSelectors() {
        var staffSet = {}, storeSet = {}, hasNoStaff = false;
        state.rows.forEach(function (r) {
            var s = norm(r[CFG.staffField]).trim();
            if (s) staffSet[s] = true; else hasNoStaff = true;
            var st = norm(r[CFG.storeField]).trim();
            if (st) storeSet[st] = true;
        });
        var sel = $("staff-select");
        var staffList = Object.keys(staffSet).sort(byJa);
        var html = "<option value=''>すべて</option>";
        staffList.forEach(function (s) { html += "<option value='" + esc(s) + "'>" + esc(s) + "</option>"; });
        if (hasNoStaff) html += "<option value='__none__'>（担当なし）</option>";
        // 覚えている担当が今の一覧に居なくても、選んだままにする（0 台と出す）
        if (state.staff && state.staff !== "__none__" && !staffSet[state.staff]) html += "<option value='" + esc(state.staff) + "'>" + esc(state.staff) + "（0台）</option>";
        sel.innerHTML = html;
        sel.value = state.staff;
        if (sel.value !== state.staff) { state.staff = ""; sel.value = ""; }
        $("staff-names").innerHTML = staffList.map(function (s) { return "<option value='" + esc(s) + "'></option>"; }).join("");

        if (state.isAdmin) {
            var ss = $("store-select"), storeList = Object.keys(storeSet).sort(byJa);
            var sh = "<option value=''>すべての店舗</option>";
            storeList.forEach(function (s) { sh += "<option value='" + esc(s) + "'>" + esc(s) + "</option>"; });
            ss.innerHTML = sh;
            ss.value = state.store;
            if (ss.value !== state.store) { state.store = ""; ss.value = ""; }
        }
    }

    function progressOf(r) {
        var n = 0, m = 0;
        CFG.fields.forEach(function (f) {
            if (!f.count || !exists(f.api)) return;
            if (f.when) {
                var ok = Object.keys(f.when).every(function (k) { return f.when[k].indexOf(norm(r[k])) !== -1; });
                if (!ok) return;
            }
            m++;
            var v = f.kind === "date" ? dateOnly(r[f.api]) : norm(r[f.api]);
            if (v === "" || v === false) return;
            if (!f.done || f.done.length === 0 || f.done.indexOf(v) !== -1) n++;
        });
        return { n: n, m: m };
    }

    function filteredRows() {
        return state.rows.filter(function (r) {
            var s = norm(r[CFG.staffField]).trim();
            if (state.staff === "__none__") { if (s) return false; }
            else if (state.staff && s !== state.staff) return false;
            if (state.isAdmin && state.store && norm(r[CFG.storeField]).trim() !== state.store) return false;
            return true;
        }).sort(function (a, b) {
            var pa = dateOnly(a[CFG.planField]), pb = dateOnly(b[CFG.planField]);
            if (pa && !pb) return -1;
            if (!pa && pb) return 1;
            if (pa !== pb) return pa < pb ? -1 : 1;
            return byJa(norm(a[CFG.customerField]), norm(b[CFG.customerField]));
        });
    }

    function renderList() {
        var rows = filteredRows(), today = todayStr();
        $("count").textContent = rows.length + " 台";
        if (state.truncated) setNotice("list-notice", "warn", "台数が多いため、先頭の " + MAX_ROWS + " 台だけを読んでいます。");
        state.gridMode = isWide();
        $("grid-status").hidden = !state.gridMode;
        state.gridView = [];
        state.active = null;
        state.editing = null;
        if (!rows.length) {
            $("list").innerHTML = "<div class='empty'>未納車はありません。</div>";
            return;
        }
        $("list").classList.toggle("list-grid", state.gridMode);
        if (state.gridMode) { renderGrid(rows); return; }
        var h = "";
        rows.forEach(function (r) {
            var p = progressOf(r), plan = dateOnly(r[CFG.planField]);
            var left = "", leftCls = "";
            if (plan) {
                var d = daysBetween(today, plan);
                if (d > 0) { left = "あと " + d + " 日"; leftCls = d <= 7 ? "soon" : ""; }
                else if (d === 0) { left = "今日"; leftCls = "soon"; }
                else { left = (-d) + " 日過ぎ"; leftCls = "over"; }
            }
            var pct = p.m ? Math.round(p.n / p.m * 100) : 0;
            var sub = [];
            if (state.staff === "" || state.isAdmin) sub.push("担当 " + (norm(r[CFG.staffField]) || "なし"));
            if (state.isAdmin) sub.push(norm(r[CFG.storeField]) || "店舗なし");
            h += "<button type='button' class='car' data-id='" + esc(r.id) + "'>" +
                "<div class='car-head'><span class='car-name'>" + esc(norm(r[CFG.customerField]) || "（お客様名なし）") + "</span>" +
                "<span class='car-model'>" + esc(norm(r[CFG.vehicleField])) + "</span></div>" +
                "<div class='car-plan'>納車予定 <b>" + esc(plan ? fmtDate(plan) : "未定") + "</b>" +
                (left ? " <span class='left " + leftCls + "'>" + esc(left) + "</span>" : "") + "</div>" +
                "<div class='car-prog'><span class='pbar'><span style='width:" + pct + "%'></span></span>" +
                "<span class='prog-num'>" + p.n + "/" + p.m + "</span></div>" +
                (sub.length ? "<div class='car-sub'>" + esc(sub.join("　")) + "</div>" : "") +
                "</button>";
        });
        $("list").innerHTML = h;
    }

    // ---------------------------------------------------------------- ①' 表（広い画面。Excel のように入れる）
    //
    // 1行＝受注車両1台、列＝管理表の列の順（js/config.js の fields）。行頭に進み具合と保存の状態。
    // 操作: セルを押す / Enter / F2 で編集、Tab・Shift+Tab で左右、Enter・矢印で上下、Esc で取り消し、
    //       チェックは Space（選んでいるチェックのセルをもう一度押しても切り替わる）、Delete で空にする。
    // 保存は自動: 行を抜けたとき、または確定から AUTOSAVE_MS 後に、その行の変えたセルだけを送る。
    //   送る前に読み直して Modified_Time を比べ、違えば送らずにセルを赤くして理由を出す。送った後は読み戻す。
    //   1行に送信は同時に1本だけ（送っている間の入力は、終わってからもう一度送る）。
    var AUTOSAVE_MS = 3000;
    var WIDE_PX = 700;

    function isWide() { return window.innerWidth >= WIDE_PX; }
    function metaOf(id) {
        if (!state.meta[id]) state.meta[id] = { edits: {}, status: "", msg: "", timer: null, saving: false, again: false, needReload: false, flash: {}, sending: {} };
        return state.meta[id];
    }
    function editable(f, row) {
        if (!f || !exists(f.api)) return false;
        if (f.kind === "bool" || f.kind === "date" || f.kind === "pick") return true;
        if (f.kind === "text") return !/[\r\n]/.test(norm(row[f.api]));
        return false;
    }
    function cellVal(row, f) {
        var m = state.meta[row.id];
        if (m && Object.prototype.hasOwnProperty.call(m.edits, f.api)) return m.edits[f.api];
        return baseValue(f, row);
    }
    // 入力中の値を含めた行（進み具合の計算用）
    function mergedRow(row) {
        var m = state.meta[row.id];
        if (!m || !Object.keys(m.edits).length) return row;
        var o = {};
        Object.keys(row).forEach(function (k) { o[k] = row[k]; });
        Object.keys(m.edits).forEach(function (k) { o[k] = m.edits[k]; });
        return o;
    }
    function fmtSlash(d) { return d && d.length >= 10 ? d.slice(0, 4) + "/" + d.slice(5, 7) + "/" + d.slice(8, 10) : ""; }
    // 日付の入力: 2026/11/2・2026-11-02・20261102・11/2（今年）を受ける。空は ""、読めなければ null
    function parseDateInput(s) {
        s = String(s || "").replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
            .replace(/[／．－]/g, "/").trim();
        if (!s) return "";
        var y, m, d, mt;
        if ((mt = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(s))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
        else if ((mt = /^(\d{1,2})[\/\-.](\d{1,2})$/.exec(s))) { y = new Date().getFullYear(); m = +mt[1]; d = +mt[2]; }
        else if ((mt = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
        else return null;
        var dt = new Date(y, m - 1, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
        return y + "-" + pad2(m) + "-" + pad2(d);
    }
    function tossText(row) {
        var d = CFG.deal, lk = row[d.lookupField];
        if (!state.tossInList) return "—";
        if (!lk || (typeof lk === "object" && !lk.id)) return "（紐づけなし）";
        if (normBool(row[d.lookupField + "." + d.naField])) return "対象外";
        var t = dateOnly(row[d.lookupField + "." + d.tossField]);
        return t ? fmtSlash(t) : "未";
    }

    function gridCols() {
        var cols = [{ head: true, label: "進み具合" }];
        CFG.fields.forEach(function (f) {
            if (f.kind !== "toss" && !exists(f.api)) return;
            cols.push({ f: f, label: f.label });
            // 車種の右に担当（すべての担当を出しているときと管理者）と店舗（管理者）
            if (f.api === CFG.vehicleField) {
                if (state.staff === "" || state.isAdmin) cols.push({ extra: CFG.staffField, label: "担当" });
                if (state.isAdmin) cols.push({ extra: CFG.storeField, label: "店舗" });
            }
        });
        return cols;
    }
    function isSticky(col) { return col.head || (col.f && (col.f.api === CFG.customerField || col.f.api === CFG.vehicleField)); }

    function renderGrid(rows) {
        state.gridView = rows;
        state.gridCols = gridCols();
        var cols = state.gridCols;
        var h = "<div class='grid-wrap' id='grid-wrap' tabindex='0' role='grid' aria-label='未納車の表'><table class='grid'><thead><tr>";
        cols.forEach(function (c, ci) {
            h += "<th class='" + (isSticky(c) ? "sticky" : "") + (c.f && !editable(c.f, {}) && c.f.kind !== "text" ? " th-ro" : "") + "' data-c='" + ci + "'>" + esc(c.label) + "</th>";
        });
        h += "</tr></thead><tbody>";
        rows.forEach(function (row, ri) {
            h += "<tr data-r='" + ri + "'>";
            cols.forEach(function (c, ci) { h += "<td data-r='" + ri + "' data-c='" + ci + "'></td>"; });
            h += "</tr>";
        });
        h += "</tbody></table></div>";
        $("list").innerHTML = h;
        rows.forEach(function (row, ri) { updateRow(ri); });
        placeSticky();
        updateGridStatus();
    }

    // 左の固定列（行頭・お客様名・車種）の left を、実際の幅から決める
    function placeSticky() {
        var table = document.querySelector("#grid-wrap table");
        if (!table) return;
        var left = 0, cols = state.gridCols;
        var heads = table.querySelectorAll("thead th");
        cols.forEach(function (c, ci) {
            if (!isSticky(c)) return;
            var w = heads[ci].getBoundingClientRect().width;
            table.querySelectorAll("[data-c='" + ci + "']").forEach(function (el) { el.style.left = left + "px"; });
            left += w;
        });
    }

    function cellEl(ri, ci) { return document.querySelector("#grid-wrap td[data-r='" + ri + "'][data-c='" + ci + "']"); }

    // 1行を描き直す（編集中のセルは触らない）
    function updateRow(ri) {
        var row = state.gridView[ri];
        if (!row) return;
        var m = state.meta[row.id];
        state.gridCols.forEach(function (c, ci) {
            if (state.editing && state.editing.r === ri && state.editing.c === ci) return;
            var td = cellEl(ri, ci);
            if (td) paintCell(td, row, c, m);
        });
    }

    function paintCell(td, row, c, m) {
        var cls = [], text = "", title = "";
        if (isSticky(c)) cls.push("sticky");
        if (c.head) {
            var p = progressOf(mergedRow(row));
            cls.push("c-head");
            var st = "";
            if (m && m.saving) st = "<span class='st st-saving'>保存中…</span>";
            else if (m && (m.status === "error" || m.status === "conflict")) { st = "<span class='st st-err'>" + esc(m.msg) + "</span>"; cls.push("row-err"); }
            else if (m && m.status === "warn") st = "<span class='st st-warn'>" + esc(m.msg) + "</span>";
            else if (m && Object.keys(m.edits).length) st = "<span class='st st-dirty'>未保存</span>";
            else if (m && m.status === "saved") st = "<span class='st st-ok'>保存済み</span>";
            if (m && m.needReload) st += " <button type='button' class='row-reload' data-reload='" + esc(row.id) + "'>読み直す</button>";
            td.innerHTML = "<b class='pn'>" + p.n + "/" + p.m + "</b>" + st;
        } else if (c.extra) {
            cls.push("ro");
            td.textContent = norm(row[c.extra]);
        } else {
            var f = c.f;
            if (f.kind === "toss") { cls.push("ro"); text = tossText(row); }
            else if (f.kind === "display") { cls.push("ro"); text = f.date ? fmtSlash(dateOnly(row[f.api])) : norm(row[f.api]); }
            else if (f.kind === "number") {
                cls.push("ro"); text = norm(row[f.api]);
                if (text !== "" && !isNaN(Number(text))) text = String(Math.round(Number(text)));
                cls.push("num");
            } else {
                var v = cellVal(row, f);
                if (!editable(f, row)) { cls.push("ro"); title = "改行を含むため、ここでは直せません（CRM の画面で直してください）"; text = String(v).replace(/[\r\n]+/g, " ⏎ "); }
                else if (f.kind === "date") text = fmtSlash(v);
                else if (f.kind === "bool") { text = v ? "✔" : ""; cls.push("c-bool"); }
                else text = v;
                if (m) {
                    var has = Object.prototype.hasOwnProperty.call(m.edits, f.api);
                    var sending = m.saving && Object.prototype.hasOwnProperty.call(m.sending, f.api);
                    if (sending) cls.push("c-saving");
                    else if (has && (m.status === "error" || m.status === "conflict")) cls.push("c-err");
                    else if (has) cls.push("c-dirty");
                    else if (m.flash[f.api]) cls.push("c-saved");
                }
            }
            td.textContent = text;
        }
        if (state.active && state.gridView[state.active.r] === row && state.gridCols[state.active.c] === c) cls.push("active");
        td.className = cls.join(" ");
        if (title) td.title = title; else td.removeAttribute("title");
    }

    function updateGridStatus() {
        var el = $("grid-status");
        if (!state.gridMode) { el.hidden = true; return; }
        var dirty = 0, saving = 0, err = 0;
        Object.keys(state.meta || {}).forEach(function (id) {
            var m = state.meta[id];
            if (m.saving) saving++;
            if (m.status === "error" || m.status === "conflict") err++;
            else if (Object.keys(m.edits).length && !m.saving) dirty++;
        });
        var parts = [];
        if (saving) parts.push("保存中 " + saving + " 行");
        if (dirty) parts.push("未保存 " + dirty + " 行（行を抜けるか数秒で保存します）");
        if (err) parts.push("保存できなかった行 " + err + " 行（行頭に理由）");
        el.className = "grid-status" + (err ? " gs-err" : (dirty || saving ? " gs-dirty" : ""));
        el.textContent = parts.length ? parts.join("　") : "入力はすべて保存済みです。セルを押すか Enter で入力、Tab・矢印で移動、Esc で取り消し。";
        el.hidden = false;
    }
    function hasUnsaved() {
        return Object.keys(state.meta || {}).some(function (id) { var m = state.meta[id]; return m.saving || Object.keys(m.edits).length > 0; });
    }

    // ---- 選択と移動
    function setActive(ri, ci, noScroll) {
        var nRows = state.gridView.length, nCols = state.gridCols.length;
        if (!nRows) return;
        ri = Math.max(0, Math.min(nRows - 1, ri));
        ci = Math.max(0, Math.min(nCols - 1, ci));
        var prev = state.active;
        state.active = { r: ri, c: ci };
        if (prev) { var pt = cellEl(prev.r, prev.c); if (pt) pt.classList.remove("active"); }
        var td = cellEl(ri, ci);
        if (td) {
            td.classList.add("active");
            if (!noScroll) scrollCellIntoView(td);
        }
        // 行を抜けたら、その行を保存する
        if (prev && prev.r !== ri) { var pr = state.gridView[prev.r]; if (pr) requestSave(pr, 0); }
    }
    function scrollCellIntoView(td) {
        var wrap = $("grid-wrap");
        if (!wrap) return;
        var stickyW = 0;
        state.gridCols.forEach(function (c, ci) { if (isSticky(c)) { var th = wrap.querySelector("th[data-c='" + ci + "']"); if (th) stickyW += th.getBoundingClientRect().width; } });
        var wr = wrap.getBoundingClientRect(), r = td.getBoundingClientRect();
        var headH = wrap.querySelector("thead").getBoundingClientRect().height;
        if (!td.classList.contains("sticky")) {
            if (r.left < wr.left + stickyW) wrap.scrollLeft -= (wr.left + stickyW - r.left);
            else if (r.right > wr.right) wrap.scrollLeft += (r.right - wr.right);
        }
        if (r.top < wr.top + headH) wrap.scrollTop -= (wr.top + headH - r.top);
        else if (r.bottom > wr.bottom) wrap.scrollTop += (r.bottom - wr.bottom);
    }
    function move(dr, dc) {
        if (!state.active) { setActive(0, 1); return; }
        setActive(state.active.r + dr, state.active.c + dc);
    }
    function activeCol() { return state.active ? state.gridCols[state.active.c] : null; }
    function activeRow() { return state.active ? state.gridView[state.active.r] : null; }

    // ---- 値を入れる
    function applyValue(row, f, v) {
        var m = metaOf(row.id), base = baseValue(f, row);
        if (v === base) delete m.edits[f.api]; else m.edits[f.api] = v;
        if (m.status !== "conflict" && !m.needReload) { m.status = ""; m.msg = ""; }
        delete m.flash[f.api];
        var ri = state.gridView.indexOf(row);
        if (ri !== -1) updateRow(ri);
        updateGridStatus();
        requestSave(row, AUTOSAVE_MS);
    }

    function startEdit(initial) {
        var c = activeCol(), row = activeRow();
        if (!c || !row || !c.f || !editable(c.f, row) || c.f.kind === "bool") return;
        var m = state.meta[row.id];
        if (m && m.saving && Object.prototype.hasOwnProperty.call(m.sending, c.f.api)) {
            setGridMessage("このセルは保存中です。少し待ってから入れてください。");
            return;
        }
        var f = c.f, td = cellEl(state.active.r, state.active.c), cur = cellVal(row, f), el;
        if (f.kind === "pick") {
            el = document.createElement("select");
            var opts = f.options.slice();
            if (cur && opts.indexOf(cur) === -1) opts.push(cur);
            var o0 = document.createElement("option"); o0.value = ""; o0.textContent = "（空）"; el.appendChild(o0);
            opts.forEach(function (o) { var op = document.createElement("option"); op.value = o; op.textContent = o; el.appendChild(op); });
            el.value = cur;
        } else {
            el = document.createElement("input");
            el.type = "text";
            if (f.kind === "date") { el.placeholder = "2026/11/2 か 11/2"; el.value = initial !== undefined ? initial : fmtSlash(cur); }
            else { el.maxLength = f.maxLength || 255; el.value = initial !== undefined ? initial : cur; }
        }
        el.className = "cell-editor";
        state.editing = { r: state.active.r, c: state.active.c, el: el, row: row, f: f, orig: cur };
        td.textContent = "";
        td.classList.add("editing");
        td.appendChild(el);
        el.addEventListener("keydown", onEditorKey);
        el.addEventListener("blur", function () { if (state.editing && state.editing.el === el) finishEdit(true, true); });
        if (f.kind === "pick") el.addEventListener("change", function () { if (state.editing && state.editing.el === el) applyValue(row, f, el.value); });
        el.focus();
        if (el.select && f.kind !== "pick" && initial === undefined) el.select();
        if (f.kind === "pick" && initial === "open" && el.showPicker) { try { el.showPicker(); } catch (e) { /* 開けなくてもキーで選べる */ } }
    }

    // 編集を終える。commit=false は取り消し。blur=true はセルの外を押したとき（日付が読めなければ取り消す）
    function finishEdit(commit, blur) {
        var ed = state.editing;
        if (!ed) return true;
        var f = ed.f, v;
        if (commit) {
            if (f.kind === "date") {
                v = parseDateInput(ed.el.value);
                if (v === null) {
                    if (!blur) { ed.el.classList.add("bad"); setGridMessage("日付は 2026/11/2 か 11/2 の形で入れてください（Esc で取り消し）。"); return false; }
                    setGridMessage("日付の形が読めなかったので、取り消しました。");
                    commit = false;
                }
            } else if (f.kind === "pick") v = ed.el.value;
            else v = ed.el.value.trim();
        }
        state.editing = null;
        var td = cellEl(ed.r, ed.c);
        if (td) td.classList.remove("editing");
        if (commit) {
            if (v !== cellVal(ed.row, f)) applyValue(ed.row, f, v);
            else if (state.gridView[ed.r] === ed.row) updateRow(ed.r);
        } else {
            if (f.kind === "pick" && cellVal(ed.row, f) !== ed.orig) applyValue(ed.row, f, ed.orig);
            else if (state.gridView[ed.r] === ed.row) updateRow(ed.r);
        }
        if (!blur) { var w = $("grid-wrap"); if (w) w.focus({ preventScroll: true }); }
        return true;
    }
    function commitEditing() { if (state.editing) finishEdit(true, true); }

    function onEditorKey(e) {
        var ed = state.editing;
        if (!ed) return;
        // 日本語の変換中（IME）の Enter・矢印は変換のためのキー。セルの確定・移動にしない
        if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
        var k = e.key;
        if (k === "Escape") { e.preventDefault(); finishEdit(false, false); return; }
        if (k === "Enter") { e.preventDefault(); if (finishEdit(true, false)) move(e.shiftKey ? -1 : 1, 0); return; }
        if (k === "Tab") { e.preventDefault(); if (finishEdit(true, false)) move(0, e.shiftKey ? -1 : 1); return; }
        if (ed.f.kind !== "pick" && (k === "ArrowUp" || k === "ArrowDown")) {
            e.preventDefault(); if (finishEdit(true, false)) move(k === "ArrowUp" ? -1 : 1, 0); return;
        }
        e.stopPropagation();
    }

    function onGridKey(e) {
        if (state.editing || !state.gridMode) return;
        if (e.target && e.target.id !== "grid-wrap") return;
        var k = e.key, c = activeCol(), row = activeRow();
        if (!state.active && /^Arrow|^Tab$|^Enter$/.test(k)) { e.preventDefault(); setActive(0, 1); return; }
        if (k === "ArrowUp") { e.preventDefault(); move(-1, 0); }
        else if (k === "ArrowDown") { e.preventDefault(); move(1, 0); }
        else if (k === "ArrowLeft") { e.preventDefault(); move(0, -1); }
        else if (k === "ArrowRight") { e.preventDefault(); move(0, 1); }
        else if (k === "Tab") { e.preventDefault(); move(0, e.shiftKey ? -1 : 1); }
        else if (k === "Enter" || k === "F2") {
            e.preventDefault();
            if (c && c.f && editable(c.f, row) && c.f.kind !== "bool") startEdit();
            else if (k === "Enter") move(e.shiftKey ? -1 : 1, 0);
        } else if (k === " " || k === "Spacebar") {
            if (c && c.f && c.f.kind === "bool" && editable(c.f, row)) { e.preventDefault(); toggleBool(); }
        } else if (k === "Delete" || k === "Backspace") {
            if (c && c.f && editable(c.f, row) && c.f.kind !== "bool") { e.preventDefault(); applyValue(row, c.f, ""); }
        } else if (k === "Process" || e.keyCode === 229) {
            // 日本語入力（IME）を始めたとき: 空の入力欄で編集を始め、変換はそこで続ける
            if (c && c.f && editable(c.f, row) && (c.f.kind === "text" || c.f.kind === "date")) startEdit("");
        } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (c && c.f && editable(c.f, row) && c.f.kind !== "bool") {
                e.preventDefault();
                if (c.f.kind === "pick") startEdit(); else startEdit(k);
            }
        }
    }
    function toggleBool() {
        var c = activeCol(), row = activeRow();
        if (!c || !c.f || c.f.kind !== "bool" || !editable(c.f, row)) return;
        var m = state.meta[row.id];
        if (m && m.saving && Object.prototype.hasOwnProperty.call(m.sending, c.f.api)) { setGridMessage("このセルは保存中です。"); return; }
        applyValue(row, c.f, !cellVal(row, c.f));
    }
    function setGridMessage(t) {
        var el = $("grid-status");
        el.textContent = t;
        el.className = "grid-status gs-err";
        el.hidden = false;
        clearTimeout(state.gridMsgTimer);
        state.gridMsgTimer = setTimeout(updateGridStatus, 4000);
    }

    function onGridMouseDown(e) {
        if (!state.gridMode) return;
        var t = e.target;
        if (t.classList && t.classList.contains("row-reload")) { e.preventDefault(); reloadRow(t.getAttribute("data-reload")); return; }
        if (t.classList && t.classList.contains("cell-editor")) return; // 編集中の入力欄の中
        var td = t.closest ? t.closest("#grid-wrap td") : null;
        if (!td) return;
        e.preventDefault(); // フォーカスは表に置く（入力欄の blur で確定する）
        if (state.editing) finishEdit(true, true);
        var ri = Number(td.getAttribute("data-r")), ci = Number(td.getAttribute("data-c"));
        var wasActive = state.active && state.active.r === ri && state.active.c === ci;
        setActive(ri, ci, true);
        $("grid-wrap").focus({ preventScroll: true });
        var c = activeCol(), row = activeRow();
        if (!c || !c.f || !editable(c.f, row)) return;
        if (c.f.kind === "bool") { if (wasActive) toggleBool(); }
        else startEdit(c.f.kind === "pick" ? "open" : undefined);
    }

    // ---- 自動保存
    function requestSave(row, delay) {
        var m = state.meta[row.id];
        if (!m || !Object.keys(m.edits).length) return;
        clearTimeout(m.timer);
        if (m.needReload) return; // 読み直すまで送らない（理由は行頭）
        m.timer = setTimeout(function () { saveRow(row); }, delay || 0);
    }
    function flushAll() {
        commitEditing();
        (state.rows || []).forEach(function (row) { var m = state.meta[row.id]; if (m && Object.keys(m.edits).length && !m.saving && !m.needReload) saveRow(row); });
    }
    function rowAlive(row) { return row.__gen === state.listSeq && state.rows.indexOf(row) !== -1; }
    function repaint(row) {
        if (!state.gridMode || !rowAlive(row)) return;
        var ri = state.gridView.indexOf(row);
        if (ri !== -1) updateRow(ri);
        updateGridStatus();
    }
    function setRowError(row, m, status, msg, needReload) {
        m.status = status; m.msg = msg; if (needReload) m.needReload = true;
        repaint(row);
    }

    async function saveRow(row) {
        var m = state.meta[row.id];
        if (!m) return;
        clearTimeout(m.timer);
        if (m.saving) { m.again = true; return; }       // 二重に送らない。終わってからもう一度
        // 編集中のセルが同じ行なら、そのセルの確定を待つ（確定で改めて保存が予約される）
        var apis = Object.keys(m.edits);
        if (!apis.length || m.needReload) return;
        var editor = "";
        if (editorReady()) {
            editor = String($("grid-editor").value || "").trim();
            if (!editor) { setRowError(row, m, "error", "表の上の「入れた方」を入れてください（入れると保存します）"); return; }
        }
        if (!norm(row.Modified_Time)) { setRowError(row, m, "error", "更新日時が分からないため、上書きを避けて保存しません", true); return; }
        var sent = {};
        apis.forEach(function (a) { sent[a] = m.edits[a]; });
        var gen = row.__gen;
        m.saving = true; m.sending = sent; m.status = ""; m.msg = ""; m.again = false;
        repaint(row);
        var data;
        try {
            var fresh = await getOne(CFG.module, row.id);
            if (row.__gen !== gen) return;
            if (!norm(fresh.Modified_Time) || norm(fresh.Modified_Time) !== norm(row.Modified_Time)) {
                var changed = [];
                CFG.fields.forEach(function (f) {
                    if (!f.api || f.kind === "toss" || !exists(f.api)) return;
                    if (baseValue(f, fresh) !== baseValue(f, row)) changed.push(f.label);
                });
                m.saving = false; m.sending = {};
                setRowError(row, m, "conflict", "ほかで変更されたため送っていません" + (changed.length ? "（" + changed.join("・") + "）" : "") + "。「読み直す」で最新に（入れた内容は消えます）", true);
                return;
            }
            data = { id: row.id };
            apis.forEach(function (a) { data[a] = toSend(a, sent[a]); });
            if (editorReady()) data[CFG.editorField] = editor;
            if (editedAtReady()) data[CFG.editedAtField] = nowIso();
            var res = await ZOHO.CRM.API.updateRecord({ Entity: CFG.module, APIData: data, Trigger: CFG.trigger });
            var r0 = res && res.data && res.data[0];
            if (!r0 || String(r0.code || "").toUpperCase() !== "SUCCESS") throw (r0 || res || "保存の応答がありませんでした");
        } catch (e) {
            if (row.__gen !== gen) return;
            m.saving = false; m.sending = {};
            setRowError(row, m, "error", "保存できませんでした（" + errText(e) + "）。セルを直すか、もう一度入れると送り直します");
            return;
        }
        // ここから先は CRM に入った後
        var back = null, backErr = null;
        try { back = await getOne(CFG.module, row.id); } catch (e2) { backErr = e2; }
        if (row.__gen !== gen) return;
        var keep = {};
        tossKeys().concat([CFG.deal.lookupField]).forEach(function (k) { keep[k] = row[k]; });
        if (back) {
            Object.keys(back).forEach(function (k) { row[k] = back[k]; });
            var lk = back[CFG.deal.lookupField], oldLk = keep[CFG.deal.lookupField];
            if (lk && oldLk && lk.id === oldLk.id) tossKeys().forEach(function (k) { row[k] = keep[k]; });
        } else {
            apis.forEach(function (a) { row[a] = data[a]; });
            row.Modified_Time = "";
        }
        // 送った値のままのセルだけ「未保存」から外す（送っている間に入れ直したセルは残す）
        apis.forEach(function (a) { if (m.edits[a] === sent[a]) delete m.edits[a]; });
        m.saving = false; m.sending = {};
        if (!back) {
            setRowError(row, m, "warn", "保存しました。保存後の内容を読み戻せませんでした（" + errText(backErr) + "）。「読み直す」を押してください", true);
            return;
        }
        var diffs = [];
        apis.forEach(function (a) { if (!sameValue(a, data[a], back)) diffs.push(labelOf(a)); });
        if (diffs.length) { m.status = "warn"; m.msg = "保存しましたが、入れた値と違う値になりました（" + diffs.join("・") + "）"; }
        else { m.status = "saved"; m.msg = ""; }
        apis.forEach(function (a) { m.flash[a] = true; });
        repaint(row);
        setTimeout(function () { apis.forEach(function (a) { delete m.flash[a]; }); if (m.status === "saved") m.status = ""; repaint(row); }, 1500);
        if (m.again || Object.keys(m.edits).length) requestSave(row, m.again ? 0 : AUTOSAVE_MS);
    }

    async function reloadRow(id) {
        var row = null;
        state.rows.forEach(function (r) { if (String(r.id) === String(id)) row = r; });
        if (!row) return;
        var m = metaOf(row.id);
        if (m.saving) return;
        if (state.editing && state.editing.row === row) finishEdit(false, true);
        var gen = row.__gen;
        try {
            var fresh = await getOne(CFG.module, row.id);
            if (row.__gen !== gen) return;
            var keep = {};
            tossKeys().forEach(function (k) { keep[k] = row[k]; });
            Object.keys(fresh).forEach(function (k) { row[k] = fresh[k]; });
            tossKeys().forEach(function (k) { row[k] = keep[k]; });
            clearTimeout(m.timer);
            state.meta[row.id] = null; delete state.meta[row.id];
            repaint(row);
        } catch (e) {
            setRowError(row, m, "error", "読み直せませんでした（" + errText(e) + "）", true);
        }
    }

    // 一覧を読み直す前・表を離れる前に、未保存があれば画面の中で知らせる
    function guardLeave(action, label) {
        commitEditing();
        if (!hasUnsaved()) { action(); return; }
        state.pendingLeave = action;
        setNotice("list-notice", "warn", "まだ CRM に入っていない入力があります（" + esc(label) + "）。" +
            "<br><button type='button' class='btn-sub' id='leave-save'>先に保存する</button> " +
            "<button type='button' class='btn-sub' id='leave-discard'>保存せずに進む（入れた内容は消えます）</button> " +
            "<button type='button' class='btn-sub' id='leave-cancel'>やめる</button>");
    }

    // ---------------------------------------------------------------- ② 1台の画面
    async function getOne(module, id) {
        var res = await ZOHO.CRM.API.getRecord({ Entity: module, RecordID: id });
        if (res && Array.isArray(res.data) && res.data[0]) return res.data[0];
        throw (res || "レコードを読めませんでした");
    }

    async function openCar(id) {
        var seq = ++state.viewSeq;
        // 一覧の読み込みの途中なら、その結果は捨てる（遅れて返って画面が一覧に戻らないように）。戻ったときに読み直す
        if (state.listLoading) { state.listSeq++; state.listLoading = false; state.listStale = true; }
        state.cur = null;
        show("view-detail");
        setNotice("detail-notice", "", "");
        $("detail-title").textContent = "読み込んでいます…";
        $("detail-sub").textContent = "";
        $("items").innerHTML = "";
        $("save-bar").hidden = true;
        var rec;
        try { rec = await getOne(CFG.module, id); }
        catch (e) {
            if (seq !== state.viewSeq) return;
            $("detail-title").textContent = "";
            setNotice("detail-notice", "error", "この車両を読めませんでした（" + esc(errText(e)) + "）。");
            return;
        }
        if (seq !== state.viewSeq) return; // 別の車両・一覧に移った
        state.cur = { id: id, base: rec, toss: null, values: {}, seq: seq };
        renderDetail();
        loadToss(rec);
    }

    async function loadToss(rec) {
        var cur = state.cur, d = CFG.deal, text;
        var lk = rec[d.lookupField];
        if (!lk || !lk.id) text = "（商談の紐づけなし）";
        else {
            try {
                var deal = await getOne(d.module, lk.id);
                if (normBool(deal[d.naField])) text = "対象外";
                else if (dateOnly(deal[d.tossField])) text = fmtDate(deal[d.tossField]);
                else text = "未";
            } catch (e) { text = "（商談を読めませんでした）"; }
        }
        if (state.cur !== cur) return; // 別の車両に移った
        cur.toss = text;
        var el = $("toss-value");
        if (el) el.textContent = text;
    }

    function baseValue(f, rec) {
        if (f.kind === "bool") return normBool(rec[f.api]);
        if (f.kind === "date") return dateOnly(rec[f.api]);
        return norm(rec[f.api]);
    }

    function renderDetail() {
        var cur = state.cur, rec = cur.base, p = progressOf(rec);
        $("detail-title").textContent = (norm(rec[CFG.customerField]) || "（お客様名なし）") + "　" + norm(rec[CFG.vehicleField]);
        $("detail-sub").textContent = "進み具合 " + p.n + "/" + p.m + (norm(rec[CFG.staffField]) ? "　担当 " + norm(rec[CFG.staffField]) : "");
        cur.values = {};
        var h = "";
        CFG.fields.forEach(function (f) {
            if (f.kind !== "toss" && !exists(f.api)) return;
            h += "<div class='item item-" + f.kind + "'><label class='item-label' for='in-" + f.key + "'>" + esc(f.label) +
                (f.note ? "<small>" + esc(f.note) + "</small>" : "") + "</label><div class='item-input'>";
            if (f.kind === "display") {
                var dv = f.date ? fmtDate(rec[f.api]) : norm(rec[f.api]);
                h += "<span class='ro'>" + esc(dv || "—") + "</span>";
            } else if (f.kind === "number") {
                var nv = norm(rec[f.api]);
                if (nv !== "" && !isNaN(Number(nv))) nv = String(Math.round(Number(nv)));
                h += "<span class='ro'>" + esc(nv === "" ? "—" : nv) + "</span>";
            } else if (f.kind === "toss") {
                h += "<span class='ro' id='toss-value'>" + esc(cur.toss || "読み込んでいます…") + "</span>";
            } else {
                var v = baseValue(f, rec);
                cur.values[f.api] = v;
                if (f.kind === "date") {
                    h += "<input type='date' id='in-" + f.key + "' data-api='" + esc(f.api) + "' value='" + esc(v) + "'>" +
                        "<button type='button' class='clear' data-clear='" + esc(f.api) + "' aria-label='消す'>消す</button>";
                } else if (f.kind === "text" && /[\r\n]/.test(v)) {
                    // 1行の入力欄は改行を落とすので、開いただけで「変更あり」になり、保存で改行が消える。
                    // 改行を含む値は表示だけにして送らない（直すのは CRM の画面で）
                    delete cur.values[f.api];
                    h += "<span class='ro ro-multi'>" + esc(v) + "</span><small class='ro-note'>改行を含むため、ここでは直せません（CRM の画面で直してください）</small>";
                } else if (f.kind === "text") {
                    h += "<input type='text' id='in-" + f.key + "' data-api='" + esc(f.api) + "' maxlength='" + (f.maxLength || 255) + "' value='" + esc(v) + "'>";
                } else if (f.kind === "bool") {
                    h += "<label class='check'><input type='checkbox' id='in-" + f.key + "' data-api='" + esc(f.api) + "'" + (v ? " checked" : "") + "> 済</label>";
                } else if (f.kind === "pick") {
                    var opts = f.options.slice();
                    // CRM の今の値が対応表に無い（選択肢が変わった）ときは、消さずに出す
                    if (v && opts.indexOf(v) === -1) opts.push(v);
                    if (opts.length <= 3) {
                        h += "<div class='pills' id='in-" + f.key + "' data-api='" + esc(f.api) + "'>";
                        opts.forEach(function (o) {
                            h += "<button type='button' class='pill" + (o === v ? " on" : "") + "' data-api='" + esc(f.api) + "' data-val='" + esc(o) + "'>" + esc(o) + "</button>";
                        });
                        h += "</div>";
                    } else {
                        h += "<select id='in-" + f.key + "' data-api='" + esc(f.api) + "'><option value=''>（未選択）</option>";
                        opts.forEach(function (o) { h += "<option value='" + esc(o) + "'" + (o === v ? " selected" : "") + ">" + esc(o) + "</option>"; });
                        h += "</select>";
                    }
                }
            }
            h += "</div></div>";
        });
        $("items").innerHTML = h;

        // 入れた方
        var ed = $("editor-wrap");
        if (editorReady()) {
            ed.hidden = false;
            var top = String($("grid-editor").value || "").trim();
            var def = top || ((state.staff && state.staff !== "__none__") ? state.staff : norm(rec[CFG.staffField]));
            $("editor-input").value = def;
            var last = norm(rec[CFG.editorField]);
            $("editor-last").textContent = last ? "前回アプリで入れた方: " + last + (editedAtReady() && norm(rec[CFG.editedAtField]) ? "（" + fmtDateTime(rec[CFG.editedAtField]) + "）" : "") : "";
        } else {
            ed.hidden = true;
        }
        $("save-bar").hidden = false;
        updateDirty();
    }

    function currentValues() {
        var out = {};
        document.querySelectorAll("#items [data-api]").forEach(function (el) {
            var api = el.getAttribute("data-api");
            if (el.classList.contains("pill") || el.classList.contains("clear")) return;
            if (el.classList.contains("pills")) {
                var on = el.querySelector(".pill.on");
                out[api] = on ? on.getAttribute("data-val") : "";
            } else if (el.type === "checkbox") out[api] = el.checked;
            else out[api] = String(el.value || "");
        });
        return out;
    }

    function changedFields() {
        var now = currentValues(), base = state.cur ? state.cur.values : {}, diff = {};
        Object.keys(now).forEach(function (api) { if (now[api] !== base[api]) diff[api] = now[api]; });
        return diff;
    }

    function updateDirty() {
        var n = Object.keys(changedFields()).length;
        var b = $("save-btn");
        b.disabled = n === 0;
        b.textContent = n ? "保存する（" + n + " 項目）" : "変更なし";
    }

    function labelOf(api) {
        for (var i = 0; i < CFG.fields.length; i++) if (CFG.fields[i].api === api) return CFG.fields[i].label;
        return api;
    }
    function toSend(api, v) {
        if (typeof v === "boolean") return v;
        v = String(v).trim();
        return v === "" ? null : v;
    }
    function sameValue(api, sent, got) {
        var f = null;
        CFG.fields.forEach(function (x) { if (x.api === api) f = x; });
        var g = f ? baseValue(f, got) : norm(got[api]);
        if (typeof g === "string") g = g.trim();
        return (sent === null ? "" : sent) === g;
    }

    async function save() {
        var cur = state.cur;
        if (!cur) return;
        var diff = changedFields(), apis = Object.keys(diff);
        if (!apis.length) { updateDirty(); return; }
        var editor = "";
        if (editorReady()) {
            editor = String($("editor-input").value || "").trim();
            if (!editor) { setNotice("detail-notice", "warn", "「入れた方」を選ぶか入れてください。"); $("editor-input").focus(); return; }
        }
        // 開いたときの更新日時が無いと、他で変わったかを比べられない。上書きを避けるため送らない
        if (!norm(cur.base.Modified_Time)) {
            setNotice("detail-notice", "error", "この車両の更新日時を読めなかったため、上書きを避けて保存しません。" +
                "<br><button type='button' class='btn-sub' id='reload-btn'>最新を読み込み直す（入れた内容は消えます）</button>");
            return;
        }
        setBusy(true);
        setNotice("detail-notice", "", "");
        var data, apisSent;
        try {
            // 1. 送る前に読み直す。開いた後に他で変わっていれば送らない
            var fresh = await getOne(CFG.module, cur.id);
            if (state.cur !== cur) { setBusy(false); return; }
            if (!norm(fresh.Modified_Time) || norm(fresh.Modified_Time) !== norm(cur.base.Modified_Time)) {
                var changedByOthers = [];
                CFG.fields.forEach(function (f) {
                    if (!f.api || f.kind === "toss" || !exists(f.api)) return;
                    if (baseValue(f, fresh) !== baseValue(f, cur.base)) changedByOthers.push(f.label);
                });
                setNotice("detail-notice", "error",
                    "開いた後に、この車両がほかで変更されました（" + esc(fmtDateTime(fresh.Modified_Time)) + "）。上書きしないよう、保存していません。" +
                    (changedByOthers.length ? "<br>変わった項目: " + esc(changedByOthers.join("・")) : "") +
                    "<br><button type='button' class='btn-sub' id='reload-btn'>最新を読み込み直す（入れた内容は消えます）</button>");
                setBusy(false);
                return;
            }
            // 2. 変えた項目だけを送る
            data = { id: cur.id };
            apisSent = apis;
            apis.forEach(function (api) { data[api] = toSend(api, diff[api]); });
            if (editorReady()) data[CFG.editorField] = editor;
            if (editedAtReady()) data[CFG.editedAtField] = nowIso();
            var res = await ZOHO.CRM.API.updateRecord({ Entity: CFG.module, APIData: data, Trigger: CFG.trigger });
            var r0 = res && res.data && res.data[0];
            if (!r0 || String(r0.code || "").toUpperCase() !== "SUCCESS") throw (r0 || res || "保存の応答がありませんでした");
        } catch (e) {
            if (state.cur !== cur) { setBusy(false); return; }
            setNotice("detail-notice", "error", "保存できませんでした（" + esc(errText(e)) + "）。入れた内容は画面に残っています。もう一度保存してください。");
            setBusy(false);
            return;
        }
        // ここから先は CRM に入った後。読み戻しが失敗しても「保存できませんでした」とは言わない
        state.listStale = true;
        var back;
        try {
            back = await getOne(CFG.module, cur.id);
        } catch (e2) {
            if (state.cur !== cur) { setBusy(false); return; }
            // 画面の基準を送った値に差し替える（このまま続けて入れても、送った項目が「変更あり」に戻らない）。
            // 更新日時は分からないので空にし、次の保存は「最新を読み込み直す」まで送らない
            var nb = JSON.parse(JSON.stringify(cur.base));
            apisSent.forEach(function (api) { nb[api] = data[api]; });
            nb.Modified_Time = "";
            cur.base = nb;
            setBusy(false);
            renderDetail();
            setNotice("detail-notice", "warn", "保存しました（" + apisSent.length + " 項目）。ただし、保存後の内容を読み戻せませんでした（" + esc(errText(e2)) +
                "）。続けて入れる前に読み込み直してください。" +
                "<br><button type='button' class='btn-sub' id='reload-btn'>最新を読み込み直す</button>");
            return;
        }
        if (state.cur !== cur) { setBusy(false); return; }
        // 3. 読み戻して画面に出す
        var diffs = [];
        apisSent.forEach(function (api) { if (!sameValue(api, data[api], back)) diffs.push(labelOf(api)); });
        cur.base = back;
        setBusy(false);
        renderDetail();
        loadToss(back);
        if (diffs.length) {
            setNotice("detail-notice", "warn", "保存しましたが、次の項目は入れた値と違う値になっています（CRM の自動処理で変わった可能性があります）: " + esc(diffs.join("・")));
        } else {
            setNotice("detail-notice", "ok", "保存しました（" + apisSent.length + " 項目）。");
        }
    }

    // 保存中は入力・戻るを止める（成功後に画面を描き直すので、保存中の入力が黙って消えないように）
    function setBusy(on) {
        state.saving = on;
        var items = $("items");
        items.inert = on;
        if (on) items.setAttribute("inert", ""); else items.removeAttribute("inert");
        items.classList.toggle("busy", on);
        // inert が効かないブラウザ向けに、入力欄とボタンも止める
        items.querySelectorAll("input, select, button").forEach(function (el) { el.disabled = on; });
        $("editor-input").disabled = on;
        $("back-btn").disabled = on;
        var btn = $("save-btn");
        if (on) { btn.disabled = true; btn.textContent = "保存しています…"; }
        else updateDirty();
    }

    // 一覧へ戻る。保存していない入力があれば画面の中で確かめる（Zoho の枠の中では window.confirm が出ないことがある）
    function backToList() {
        if (state.saving) return;
        if (state.cur && Object.keys(changedFields()).length) {
            setNotice("detail-notice", "warn", "保存していない入力があります。一覧に戻ると、入れた内容は消えます。" +
                "<br><button type='button' class='btn-sub' id='leave-yes'>保存せずに一覧へ戻る</button> " +
                "<button type='button' class='btn-sub' id='leave-no'>この画面に残る</button>");
            window.scrollTo(0, 0);
            return;
        }
        leaveToList();
    }
    function leaveToList() {
        state.cur = null;
        state.viewSeq++;
        if (state.listStale) loadList(); else { show("view-list"); renderList(); }
    }

    // ---------------------------------------------------------------- 画面の操作
    function wire() {
        $("staff-select").addEventListener("change", function () {
            commitEditing();
            var prev = state.staff;
            state.staff = this.value;
            lsSet(storageKey("staff"), state.staff);
            // 「入れた方」は担当の選択と同じ値を既定にする（自分で書き換えていればそのまま）
            var ge = $("grid-editor"), gv = String(ge.value || "").trim();
            if (state.staff && state.staff !== "__none__" && (!gv || gv === prev)) ge.value = state.staff;
            renderList();
        });
        $("store-select").addEventListener("change", function () {
            commitEditing();
            state.store = this.value;
            lsSet(storageKey("store"), state.store);
            renderList();
        });
        $("grid-editor").addEventListener("change", function () {
            // 「入れた方」が入るのを待っていた行を送る
            Object.keys(state.meta || {}).forEach(function (id) {
                var m = state.meta[id];
                if (m && m.status === "error" && !m.needReload && Object.keys(m.edits).length) {
                    state.rows.forEach(function (r) { if (String(r.id) === String(id)) requestSave(r, 0); });
                }
            });
        });
        $("reload-list").addEventListener("click", function () { guardLeave(loadList, "一覧を読み直す"); });
        $("list").addEventListener("click", function (ev) {
            var b = ev.target.closest ? ev.target.closest(".car") : null;
            if (b) openCar(b.getAttribute("data-id"));
        });
        $("list").addEventListener("mousedown", onGridMouseDown);
        $("list").addEventListener("keydown", onGridKey);
        $("list-notice").addEventListener("click", function (ev) {
            var id = ev.target && ev.target.id;
            if (id === "leave-save") { setNotice("list-notice", "", ""); state.pendingLeave = null; flushAll(); }
            else if (id === "leave-discard") {
                Object.keys(state.meta || {}).forEach(function (k) { if (state.meta[k]) clearTimeout(state.meta[k].timer); });
                state.meta = {};
                setNotice("list-notice", "", "");
                var act = state.pendingLeave; state.pendingLeave = null;
                if (act) act();
            } else if (id === "leave-cancel") { setNotice("list-notice", "", ""); state.pendingLeave = null; }
        });
        var rt = null;
        window.addEventListener("resize", function () {
            clearTimeout(rt);
            rt = setTimeout(function () {
                if ($("view-list").hidden || !state.rows) return;
                if (isWide() !== state.gridMode) { commitEditing(); flushAll(); renderList(); }
                else if (state.gridMode) placeSticky();
            }, 200);
        });
        window.addEventListener("beforeunload", function (e) {
            if (hasUnsaved()) { e.preventDefault(); e.returnValue = ""; }
        });
        $("back-btn").addEventListener("click", backToList);
        $("save-btn").addEventListener("click", save);
        $("items").addEventListener("click", function (ev) {
            var t = ev.target;
            if (t.classList.contains("pill")) {
                var wasOn = t.classList.contains("on");
                t.parentNode.querySelectorAll(".pill").forEach(function (p) { p.classList.remove("on"); });
                if (!wasOn) t.classList.add("on"); // もう一度押すと未選択に戻る
                updateDirty();
            } else if (t.classList.contains("clear")) {
                var inp = t.parentNode.querySelector("input[type=date]");
                if (inp) inp.value = "";
                updateDirty();
            }
        });
        $("items").addEventListener("input", updateDirty);
        $("items").addEventListener("change", updateDirty);
        $("detail-notice").addEventListener("click", function (ev) {
            var id = ev.target && ev.target.id;
            if (id === "reload-btn" && state.cur && !state.saving) openCar(state.cur.id);
            else if (id === "leave-yes") leaveToList();
            else if (id === "leave-no") setNotice("detail-notice", "", "");
        });
    }

    document.addEventListener("DOMContentLoaded", function () {
        try {
            if (!CFG) { fatal("設定を読めませんでした", "js/config.js が読み込めていません。"); return; }
            wire();
            boot();
        } catch (e) {
            fatal("画面を開けませんでした", errText(e));
        }
    });
})();
