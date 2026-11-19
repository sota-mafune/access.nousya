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
        cur: null              // 開いている1台: { id, base, toss, values }
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
    function listFields() {
        var want = ["id", CFG.ownerField, "Modified_Time", CFG.vehicleField, CFG.customerField, CFG.staffField, CFG.storeField,
            CFG.planField, CFG.doneField, CFG.categoryField];
        CFG.fields.forEach(function (f) {
            if (f.count && f.api) want.push(f.api);
            if (f.when) Object.keys(f.when).forEach(function (k) { want.push(k); });
        });
        var seen = {}, out = [];
        want.forEach(function (a) { if (a && !seen[a] && (a === "id" || exists(a))) { seen[a] = true; out.push(a); } });
        return out;
    }

    async function coqlAll(where) {
        var cols = listFields().join(", ");
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
            break; // 0 件（204）は空で返る
        }
        return out;
    }

    async function loadList() {
        show("view-list");
        setNotice("list-notice", "", "");
        $("list").innerHTML = "<div class='loading'>読み込んでいます…</div>";
        var notDone = "(" + CFG.doneField + " = false)";
        var rows;
        try {
            if (state.isAdmin) {
                rows = await coqlAll(notDone);
            } else {
                try {
                    rows = await coqlAll(notDone + " and " + CFG.ownerField + " = '" + String(state.user.id).replace(/[^0-9]/g, "") + "'");
                } catch (e1) {
                    // 担当者での絞り込みが通らなければ、未納車を読んで手元で絞る
                    rows = (await coqlAll(notDone)).filter(function (r) { return r[CFG.ownerField] && String(r[CFG.ownerField].id) === String(state.user.id); });
                }
            }
        } catch (e) {
            $("list").innerHTML = "";
            setNotice("list-notice", "error", "一覧を読めませんでした（" + esc(errText(e)) + "）。タブを開き直してください。");
            return;
        }
        state.rows = rows.filter(function (r) { return !normBool(r[CFG.doneField]); });
        state.listStale = false;
        fillSelectors();
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
        if (!rows.length) {
            $("list").innerHTML = "<div class='empty'>未納車はありません。</div>";
            return;
        }
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

    // ---------------------------------------------------------------- ② 1台の画面
    async function getOne(module, id) {
        var res = await ZOHO.CRM.API.getRecord({ Entity: module, RecordID: id });
        if (res && Array.isArray(res.data) && res.data[0]) return res.data[0];
        throw (res || "レコードを読めませんでした");
    }

    async function openCar(id) {
        show("view-detail");
        setNotice("detail-notice", "", "");
        $("detail-title").textContent = "読み込んでいます…";
        $("detail-sub").textContent = "";
        $("items").innerHTML = "";
        $("save-bar").hidden = true;
        var rec;
        try { rec = await getOne(CFG.module, id); }
        catch (e) {
            $("detail-title").textContent = "";
            setNotice("detail-notice", "error", "この車両を読めませんでした（" + esc(errText(e)) + "）。");
            return;
        }
        state.cur = { id: id, base: rec, toss: null, values: {} };
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
            var def = (state.staff && state.staff !== "__none__") ? state.staff : norm(rec[CFG.staffField]);
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
        var btn = $("save-btn");
        btn.disabled = true;
        btn.textContent = "保存しています…";
        setNotice("detail-notice", "", "");
        try {
            // 1. 送る前に読み直す。開いた後に他で変わっていれば送らない
            var fresh = await getOne(CFG.module, cur.id);
            if (norm(fresh.Modified_Time) !== norm(cur.base.Modified_Time)) {
                var changedByOthers = [];
                CFG.fields.forEach(function (f) {
                    if (!f.api || f.kind === "toss" || !exists(f.api)) return;
                    if (baseValue(f, fresh) !== baseValue(f, cur.base)) changedByOthers.push(f.label);
                });
                setNotice("detail-notice", "error",
                    "開いた後に、この車両がほかで変更されました（" + esc(fmtDateTime(fresh.Modified_Time)) + "）。上書きしないよう、保存していません。" +
                    (changedByOthers.length ? "<br>変わった項目: " + esc(changedByOthers.join("・")) : "") +
                    "<br><button type='button' class='btn-sub' id='reload-btn'>最新を読み込み直す（入れた内容は消えます）</button>");
                updateDirty();
                return;
            }
            // 2. 変えた項目だけを送る
            var data = { id: cur.id };
            apis.forEach(function (api) { data[api] = toSend(api, diff[api]); });
            if (editorReady()) data[CFG.editorField] = editor;
            if (editedAtReady()) data[CFG.editedAtField] = nowIso();
            var res = await ZOHO.CRM.API.updateRecord({ Entity: CFG.module, APIData: data, Trigger: CFG.trigger });
            var r0 = res && res.data && res.data[0];
            if (!r0 || String(r0.code || "").toUpperCase() !== "SUCCESS") throw (r0 || res || "保存の応答がありませんでした");
            // 3. 読み戻して画面に出す
            var back = await getOne(CFG.module, cur.id);
            var diffs = [];
            apis.forEach(function (api) { if (!sameValue(api, data[api], back)) diffs.push(labelOf(api)); });
            cur.base = back;
            state.listStale = true;
            renderDetail();
            loadToss(back);
            if (diffs.length) {
                setNotice("detail-notice", "warn", "保存しましたが、次の項目は入れた値と違う値になっています（CRM の自動処理で変わった可能性があります）: " + esc(diffs.join("・")));
            } else {
                setNotice("detail-notice", "ok", "保存しました（" + apis.length + " 項目）。");
            }
        } catch (e) {
            setNotice("detail-notice", "error", "保存できませんでした（" + esc(errText(e)) + "）。入れた内容は画面に残っています。もう一度保存してください。");
            updateDirty();
        }
    }

    function backToList() {
        if (state.cur && Object.keys(changedFields()).length) {
            if (!window.confirm("保存していない入力があります。一覧に戻りますか？")) return;
        }
        state.cur = null;
        if (state.listStale) loadList(); else { show("view-list"); renderList(); }
    }

    // ---------------------------------------------------------------- 画面の操作
    function wire() {
        $("staff-select").addEventListener("change", function () {
            state.staff = this.value;
            lsSet(storageKey("staff"), state.staff);
            renderList();
        });
        $("store-select").addEventListener("change", function () {
            state.store = this.value;
            lsSet(storageKey("store"), state.store);
            renderList();
        });
        $("reload-list").addEventListener("click", function () { loadList(); });
        $("list").addEventListener("click", function (ev) {
            var b = ev.target.closest ? ev.target.closest(".car") : null;
            if (b) openCar(b.getAttribute("data-id"));
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
            if (ev.target && ev.target.id === "reload-btn" && state.cur) openCar(state.cur.id);
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
