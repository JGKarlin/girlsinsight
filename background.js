// Background script for GirlsinSight Chrome extension - Updated with better error handling
try {
    importScripts('lib/xlsx.full.min.js');
    importScripts('article-pipeline.js', 'rendered-article-session.js', 'girlschannel-parsing.js');
} catch (e) {
    console.error(e);
}

const {
    ArticlePipeline,
    buildArticleExcerpt,
    collectArticleCandidates,
} = globalThis.GirlsinSightArticlePipeline;
const { RenderedArticleSession } = globalThis.GirlsinSightRenderedArticle;
const { compareCommentNumbers } = globalThis.GirlsinSightParsing;

const DEBUG_MODE = false; // true shows article source details and verbose logs
const debugLog = (...args) => { if (DEBUG_MODE) console.log(...args); };

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
// Google's recommended replacement for gemini-2.5-pro and gemini-2.5-flash,
// which are deprecated and auto-route to other models from December 1, 2026.
const GEMINI_MODEL = 'gemini-3.8-flash';
// If a key cannot use GEMINI_MODEL, the newest stable "gemini-X.Y-flash" it can
// use is chosen instead, as long as it accepts thinkingLevel (3.6 and newer).
const MIN_FALLBACK_FLASH_VERSION = 306; // major * 100 + minor
// Explicitly off for the current adjustable categories, so a change to
// Google's defaults cannot start refusing ordinary forum threads.
const SAFETY_SETTINGS = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
].map(category => ({ category, threshold: 'OFF' }));
// Longest wait a rate-limit reply may ask for before we give up instead.
const MAX_RETRY_WAIT_MS = 30_000;
// How often streamed essay text is forwarded to the side panel.
const DRAFT_INTERVAL_MS = 300;
// Comments sent for sentiment analysis in manual mode, until the user picks a number.
const DEFAULT_COMMENTS_TO_ANALYZE = 30;
// Finished analyses kept in local storage, one per topic, newest first.
const MAX_SAVED_ANALYSES = 5;
// Gemini errors that no later request in the run can get past: a rejected key,
// or a Prepay project whose credits are used up (Google blocks such a project
// outright instead of falling back to the free tier).
const RUN_ENDING_ERROR_CODES = ['API_KEY', 'PREPAID_CREDITS_DEPLETED'];

const i18n = {
    messages: {},
    currentLang: 'ja', // Default language

    async init(lang) {
        this.currentLang = lang || (await chrome.storage.sync.get('language')).language || 'ja';
        try {
            const url = chrome.runtime.getURL(`_locales/${this.currentLang}/messages.json`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch: ${response.statusText}`);
            }
            this.messages = await response.json();
            debugLog(`Localization loaded for: ${this.currentLang}`);
        } catch (error) {
            console.error(`Error initializing localization for ${this.currentLang}, falling back to English:`, error);
            try {
                const url = chrome.runtime.getURL(`_locales/en/messages.json`);
                const response = await fetch(url);
                this.messages = await response.json();
                this.currentLang = 'en';
            } catch (fallbackError) {
                console.error('Failed to load fallback English localization:', fallbackError);
                this.messages = {};
            }
        }
    },

    getMessage(key, replacements) {
        const messageData = this.messages[key];
        if (!messageData) {
            console.warn(`[BG] Missing localization for key: ${key}`);
            return key; // Fallback to the key itself
        }
        let message = messageData.message;
        if (replacements && messageData.placeholders) {
             Object.keys(messageData.placeholders).forEach((placeholderName, i) => {
                const replacementValue = Array.isArray(replacements) ? replacements[i] : replacements;
                if (replacementValue !== undefined) {
                    // Chrome i18n uses $placeholder$ format in the message string
                    message = message.replace(new RegExp(`\\$${placeholderName}\\$`, 'gi'), replacementValue);
                }
            });
        } else if (replacements && Array.isArray(replacements)) {
            // Fallback for simple $1, $2 style placeholders
            replacements.forEach((rep, i) => {
                message = message.replace(`$${i + 1}`, rep);
            });
        }
        return message;
    }
};

class GirlsinSightBackground {
    constructor() {
        this.settings = {};
        this.isRequestInProgress = false;
        this.keepAliveInterval = null;
        this.analysisPromises = new Map(); // For managing phased analysis
        this.analysisControllers = new Map();
        this.activeAnalysisId = null;
        this.tabUpdatedListenerRegistered = false;
        this.initialize();
    }
    
    async initialize() {
        await this.loadSettings();
        await i18n.init(this.settings.language); // Initialize localization
        await this.configureActionDefaultUI();
        this.initializeListeners();
        await this.createContextMenu(); // Create context menu after localization is ready
    }

    /**
     * Prefer opening the side panel when the toolbar icon is clicked.
     * Falls back to the popup if the Side Panel API is unavailable.
     */
    async configureActionDefaultUI() {
        const sidePanelAvailable = typeof chrome.sidePanel?.open === 'function' &&
                                   typeof chrome.sidePanel?.setPanelBehavior === 'function';

        if (sidePanelAvailable) {
            // Tell Chrome to open the side panel natively on action click.
            try {
                await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
            } catch (e) {
                console.warn('[GirlsinSight] setPanelBehavior failed:', e);
            }
            // Ensure no runtime popup overrides the side-panel click.
            try {
                await chrome.action.setPopup({ popup: '' });
            } catch (_) {}
        } else {
            // Older build without Side Panel API — fall back to popup.
            console.warn('[GirlsinSight] Side panel API unavailable; falling back to popup.');
            try {
                await chrome.action.setPopup({ popup: 'popup.html' });
            } catch (e) {
                console.error('[GirlsinSight] Failed to set popup fallback:', e);
            }
        }
    }
    
    // Initialize event listeners
    initializeListeners() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            // Forward all messages to the single handler
            this.handleMessage(request, sender, sendResponse);
            // Return true to indicate that the response will be sent asynchronously.
            return true;
        });
        
        chrome.runtime.onInstalled.addListener((details) => {
            this.onInstalled(details);
        });
        
        chrome.runtime.onStartup.addListener(() => {
            this.createContextMenu();
            void this.configureActionDefaultUI();
        });

        // Explicitly open the side panel on toolbar icon click.
        // This fires because there is no default_popup set in the manifest.
        // It is a reliable fallback even if setPanelBehavior is not honoured.
        chrome.action.onClicked.addListener(async (tab) => {
            if (typeof chrome.sidePanel?.open === 'function') {
                try {
                    await chrome.sidePanel.open({ windowId: tab.windowId });
                } catch (error) {
                    console.warn('[GirlsinSight] sidePanel.open failed:', error);
                }
            }
        });

        chrome.contextMenus.onClicked.addListener(this.handleContextMenu.bind(this));

        // The side panel holds a port named "analysis:<id>" open for each run.
        // Chrome disconnects it when the panel closes or reloads; stop the run
        // then so no one pays for Gemini output nobody will see.
        chrome.runtime.onConnect.addListener(port => {
            const match = /^analysis:(.+)$/.exec(port.name || '');
            if (!match) return;
            port.onDisconnect.addListener(() => {
                if (this.analysisControllers.has(match[1])) {
                    void this.abortAnalysis({ analysisId: match[1] });
                }
            });
        });
    }
    
    // Create context menu with localized strings
    async createContextMenu() {
        try {
            // Remove any existing context menus
            await chrome.contextMenus.removeAll();
            
            // Create context menu for settings with localized title
            const menuTitle = i18n.getMessage('settingsTitle') || 'Settings'; // Fallback to English
            chrome.contextMenus.create({
                id: 'open-settings',
                title: menuTitle,
                contexts: ['action']
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error('Error creating context menu:', chrome.runtime.lastError);
                } else {
                    debugLog('Context menu created successfully with title:', menuTitle);
                }
            });
            
        } catch (error) {
            console.error('Error creating context menu:', error);
        }

        // Register this once even though context-menu labels may be rebuilt.
        if (!this.tabUpdatedListenerRegistered) {
            this.tabUpdatedListenerRegistered = true;
            chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
            if (changeInfo.status === 'complete' && tab.url) {
                // Ignore inactive rendered-article tabs so analysis does not
                // disturb the active GirlsChannel side panel.
                const isGirlsChannel = tab.url.startsWith('https://girlschannel.net/');
                const isTopicPage = tab.url.includes('/topics/');

                if (isGirlsChannel) {
                    // Only update side panel for active tabs
                    if (tab.active) {
                        await chrome.sidePanel.setOptions({
                            tabId,
                            path: 'popup.html',
                            enabled: true
                        });
                        
                        // Small delay to ensure the side panel is ready
                        setTimeout(() => {
                            (async () => {
                                try {
                                    if (isTopicPage) {
                                        // Notify the side panel to refresh when navigating to a new topic
                                        await chrome.runtime.sendMessage({
                                            action: 'urlChanged',
                                            url: tab.url,
                                            tabId: tabId
                                        });
                                    } else {
                                        // On non-topic GirlsChannel pages, show welcome screen
                                        await chrome.runtime.sendMessage({
                                            action: 'showWelcomeScreen',
                                            reason: 'nonTopicPage'
                                        });
                                    }
                                } catch (error) {
                                    if (error.message.includes('Receiving end does not exist')) {
                                        // This is expected if the side panel is not open.
                                        // No action needed, we can safely ignore this.
                                    } else {
                                        // Log other unexpected errors.
                                        console.error("Error sending message:", error);
                                    }
                                }
                            })();
                        }, 100);
                    }
                } else {
                    // When navigating away from GirlsChannel entirely
                    // Only handle side panel for active tabs (not background fetch tabs)
                    if (tab.active) {
                        // First send a message to reset the side panel before disabling it
                        try {
                            await chrome.runtime.sendMessage({
                                action: 'showWelcomeScreen',
                                reason: 'leftGirlsChannel'
                            });
                        } catch (error) {
                            // Ignore if side panel is not open
                        }
                        
                        // This is required to disable the side panel when navigating away
                        await chrome.sidePanel.setOptions({
                            tabId,
                            enabled: false
                        });
                    }
                }
            }
            });
        }
    }
    
    // Handle installation. Chrome also fires onInstalled for extension and
    // browser updates; defaults are written only on a fresh install so updates
    // keep the user's settings.
    onInstalled(details = {}) {
        debugLog('GirlsinSight onInstalled:', details.reason);

        if (details.reason === 'install') {
            chrome.storage.sync.set({
                language: 'ja',
                commentsToAnalyze: DEFAULT_COMMENTS_TO_ANALYZE,
                scrapeReplies: false,
            });
        }
        
        void this.configureActionDefaultUI();

        // Create context menu on installation (with fallback title)
        setTimeout(() => {
            this.createContextMenu();
        }, 1000); // Small delay to ensure everything is initialized
    }

    // Handle context menu click
    handleContextMenu(info, tab) {
        if (info.menuItemId === 'open-settings') {
            // Open the side panel and signal it to show the settings view
            chrome.sidePanel.open({ windowId: tab.windowId }, () => {
                chrome.storage.local.set({ openSettings: true });
            });
        }
    }
    
    // Load settings from storage. Preferences sync across the user's browsers;
    // the API key stays in local storage on this device only.
    async loadSettings() {
        try {
            const [result, local] = await Promise.all([
                chrome.storage.sync.get([
                    'geminiApiKey',
                    'language',
                    'commentsToAnalyze',
                    'commentsToDisplay',
                    'autoCommentCalculation',
                    'scrapeReplies'
                ]),
                chrome.storage.local.get('geminiApiKey'),
            ]);

            // Versions before 1.5 kept the key in sync storage; move it here.
            let geminiApiKey = local.geminiApiKey || null;
            if (result.geminiApiKey) {
                if (!geminiApiKey) {
                    geminiApiKey = result.geminiApiKey;
                    await chrome.storage.local.set({ geminiApiKey });
                }
                await chrome.storage.sync.remove('geminiApiKey');
            }

            this.settings = {
                geminiApiKey,
                language: result.language || 'ja',
                commentsToAnalyze: result.commentsToAnalyze || DEFAULT_COMMENTS_TO_ANALYZE,
                commentsToDisplay: result.commentsToDisplay || 5,
                autoCommentCalculation: result.autoCommentCalculation !== false,
                scrapeReplies: result.scrapeReplies || false
            };
            return this.settings;
        } catch (error) {
            console.error('Error loading settings:', error);
            return {}; // Return empty settings on error
        }
    }
    
    // Handle messages
    async handleMessage(request, sender, sendResponse) {
        if (request.action === 'getLocalizedString') {
            const { key, substitutions } = request;
            const message = i18n.getMessage(key, substitutions);
            sendResponse(message);
            return; // Synchronous response, no further processing
        }

        if (request.action === 'abortAnalysis') {
            const result = await this.abortAnalysis(request.data || {});
            sendResponse(result);
            return;
        }

        if (this.isRequestInProgress && request.action !== 'extractionProgress' && request.action !== 'analysisProgress') {
            debugLog("Request already in progress. Ignoring new request.");
            sendResponse({ success: false, error: "Request in progress" });
            return;
        }
        
        // Allow progress updates to come through even if another request is active.
        if (request.action !== 'extractionProgress' && request.action !== 'analysisProgress') {
            this.isRequestInProgress = true;
        }
        
        try {
            switch (request.action) {
                case 'settingsUpdated':
                    await this.loadSettings(); // Reload settings
                    await i18n.init(this.settings.language); // Re-initialize localization
                    await this.createContextMenu(); // Update context menu with new language
                    sendResponse({ success: true });
                    break;
                    
                    
                case 'startFullAnalysis':
                    this.startFullAnalysis(request.data)
                        .then(result => sendResponse(result))
                        .catch(err => sendResponse({ success: false, error: err.message }));
                    return true; // Indicates async response

                case 'generateExcel':
                    const excelResult = await this.generateExcel(request.data);
                    sendResponse(excelResult);
                    break;
                    
                case 'extractionProgress':
                case 'analysisProgress':
                    // Forward progress message to popup
                    this.forwardProgressToPopup(request);
                    sendResponse({ success: true });
                    break;

                case 'validateApiKey':
                    const validationResult = await this.validateApiKey(request.apiKey);
                    sendResponse(validationResult);
                    break;
                    
                case 'initialDataReady':
                    if (sender.tab && request.analysisId && this.analysisPromises.has(request.analysisId)) {
                        const pending = this.analysisPromises.get(request.analysisId);
                        if (pending.tabId === sender.tab.id) pending.initialDataResolver(request.data);
                    }
                    // No sendResponse needed, this is a one-way notification
                    break;
                case 'allCommentsReady':
                    if (sender.tab && request.analysisId && this.analysisPromises.has(request.analysisId)) {
                        const pending = this.analysisPromises.get(request.analysisId);
                        if (pending.tabId === sender.tab.id) pending.allCommentsResolver(request.data);
                    }
                    break;
                    
                case 'fetchPage':
                    // Handle fetch requests from content script to avoid CORS issues
                    this.handleContentScriptFetch(request.url, {
                        signal: request.analysisId
                            ? this.analysisControllers.get(request.analysisId)?.signal
                            : undefined,
                    })
                        .then(result => sendResponse(result))
                        .catch(error => sendResponse({ success: false, error: error.message }));
                    return true; // Indicates async response
                    
                default:
                    sendResponse({ success: false, error: 'Unknown action' });
            }
        } catch (error) {
            console.error('Error handling message:', error);
            sendResponse({ success: false, error: error.message });
        } finally {
            if (request.action !== 'extractionProgress' && request.action !== 'analysisProgress') {
                this.isRequestInProgress = false;
            }
        }
    }

    abortError() {
        const error = new Error('Analysis cancelled');
        error.name = 'AbortError';
        return error;
    }

    throwIfAborted(signal) {
        if (signal && signal.aborted) throw this.abortError();
    }

    awaitWithSignal(operation, signal) {
        const promise = Promise.resolve(operation);
        if (!signal) return promise;
        if (signal.aborted) return Promise.reject(this.abortError());

        return new Promise((resolve, reject) => {
            const handleAbort = () => {
                signal.removeEventListener('abort', handleAbort);
                reject(this.abortError());
            };
            signal.addEventListener('abort', handleAbort, { once: true });
            promise.then(
                value => {
                    signal.removeEventListener('abort', handleAbort);
                    resolve(value);
                },
                error => {
                    signal.removeEventListener('abort', handleAbort);
                    reject(error);
                }
            );
        });
    }

    async delayWithSignal(milliseconds, signal) {
        await this.awaitWithSignal(
            new Promise(resolve => setTimeout(resolve, milliseconds)),
            signal
        );
    }

    async abortAnalysis({ analysisId, tabId }) {
        const controller = analysisId ? this.analysisControllers.get(analysisId) : null;
        if (controller) controller.abort();

        const targetTabId = tabId || (analysisId && this.analysisPromises.get(analysisId)?.tabId);
        if (targetTabId) {
            try {
                await chrome.tabs.sendMessage(targetTabId, {
                    action: 'abortExtraction',
                    analysisId,
                });
            } catch (_) {
                // The content script may already have completed or navigated away.
            }
        }
        return { success: true, cancelled: Boolean(controller) };
    }

    async startFullAnalysis(data) {
        const { tabId, settings, articleAccessGranted = true } = data;
        const analysisId = data.analysisId || crypto.randomUUID();
        if (this.activeAnalysisId) {
            return { success: false, analysisId, error: 'Another analysis is already running.' };
        }
        this.activeAnalysisId = analysisId;
        const controller = new AbortController();
        const { signal } = controller;
        this.analysisControllers.set(analysisId, controller);
        this.currentAnalysisData = { allComments: [], analysisId };
        // The side panel sends its current settings with each run. Use them for
        // the whole run (summary, sentiment sample, Gemini key) so the worker's
        // stored copy cannot disagree with what the panel shows.
        this.settings = { ...this.settings, ...settings };
        this.keepAlive();

        try {
        
        // Validate API key before starting any analysis
        if (!settings.geminiApiKey) {
            chrome.runtime.sendMessage({ 
                action: 'analysisFailed', 
                analysisId,
                error: i18n.getMessage('apiKeyMissing') 
            });
            return { success: false, error: i18n.getMessage('apiKeyMissing') };
        }
        
        // Check if API key is valid before proceeding
        this.sendProgress(i18n.getMessage('progressValidatingApiKey') || 'Validating API key...', analysisId);
        const validationResult = await this.validateApiKey(settings.geminiApiKey, { signal });
        if (!validationResult.success) {
            const error = validationResult.modelUnavailable
                ? validationResult.error
                : i18n.getMessage('apiKeyInvalid');
            chrome.runtime.sendMessage({ action: 'analysisFailed', analysisId, error });
            return { success: false, error };
        }
        this.geminiModel = validationResult.model;
        
        // Setup promises to wait for data from content script
        let initialDataResolver, allCommentsResolver;
        const initialDataPromise = new Promise(resolve => initialDataResolver = resolve);
        const allCommentsPromise = new Promise(resolve => allCommentsResolver = resolve);

        this.analysisPromises.set(analysisId, { tabId, initialDataResolver, allCommentsResolver });

            // --- Send a single command to start the phased extraction ---
            await this.awaitWithSignal(chrome.tabs.sendMessage(tabId, {
                action: 'startPhasedExtraction',
                analysisId,
                options: { scrapeReplies: settings.scrapeReplies }
            }), signal);

            // --- Phase 1: Wait for initial data and start summary generation ---
            const initialDataResponse = await this.awaitWithSignal(initialDataPromise, signal);
            if (!initialDataResponse || !initialDataResponse.success) {
                throw new Error('Failed to extract initial topic data.');
            }
            const { topicData, firstPageComments } = initialDataResponse.data;

            this.currentAnalysisData = { ...this.currentAnalysisData, ...topicData };
            
            const summaryPromise = (async () => {
                let summary;
                let articleInfo = { text: null, source: null };
                const firstComment = firstPageComments[0];
                
                if (firstComment && firstComment.urls && firstComment.urls.length > 0 && articleAccessGranted) {
                    this.sendProgress(i18n.getMessage('progressCheckingArticle'), analysisId);
                    // Pass just an array with the first comment for article fetching
                    articleInfo = await this.fetchArticleFromComment([firstComment], { signal, analysisId });
                    
                    this.sendProgress(i18n.getMessage('progressSendingSummaryRequest'), analysisId);
                    summary = await this.generateSummary(topicData, [firstComment], articleInfo.text, { signal });
                    this.sendProgress(i18n.getMessage('progressSummaryReceived'), analysisId);
                } else {
                    this.sendProgress(i18n.getMessage('progressSendingSummaryRequest'), analysisId);
                    // Use the first comment or empty array if no first comment
                    summary = await this.generateSummary(topicData, firstComment ? [firstComment] : [], null, { signal });
                    this.sendProgress(i18n.getMessage('progressSummaryReceived'), analysisId);
                }

                this.throwIfAborted(signal);
                this.currentAnalysisData.summary = summary;
                this.currentAnalysisData.source = articleInfo.source;
                this.currentAnalysisData.sourceDetails = articleInfo.sourceDetails;
                this.sendPartialResults('summary', { 
                    summary: summary, 
                    source: articleInfo.source,
                    sourceDetails: articleInfo.sourceDetails
                }, analysisId);
                
                return { summary, articleInfo };
            })();

            // --- Phase 2: Wait for all comments and summary to finish before proceeding ---
            const [allCommentsResponse] = await Promise.all([
                this.awaitWithSignal(allCommentsPromise, signal),
                summaryPromise,
            ]);

            if (!allCommentsResponse || !allCommentsResponse.success) {
                throw new Error('Failed to extract all comments.');
            }
            
            // Add the requested pause after summary is received.
            await this.delayWithSignal(1500, signal);
            
            // Process comments once for all analyses
            const { comments: rawComments, activityStats } = allCommentsResponse.data;
            
            debugLog('startFullAnalysis - processing comments:', {
                rawCommentsLength: rawComments.length,
                firstRawComment: rawComments[0]
            });
            
            const processedComments = this.processComments(rawComments);
            debugLog('startFullAnalysis - after processing:', {
                processedCommentsLength: processedComments.length,
                firstProcessedComment: processedComments[0],
                hasUpvoteRatio: processedComments[0] && 'upvoteRatio' in processedComments[0]
            });
            
            this.currentAnalysisData.allComments = processedComments;

            // --- Run quick calculations first and update UI ---
            this.sendProgress(i18n.getMessage('progressCalculatingStats'), analysisId);
            // Size the sample from main comments only, as analyzeSentiment does.
            const mainCommentCount = processedComments.filter(c => !c.isSubComment).length;
            const totalToAnalyze = this.getCommentsToAnalyzeCount(mainCommentCount, settings);
            const stats = this.calculateStatistics(processedComments, totalToAnalyze);
            const topComments = this.getTopComments(processedComments, settings.commentsToDisplay);
            const bottomComments = this.getBottomComments(processedComments, settings.commentsToDisplay);

            this.currentAnalysisData.stats = stats;
            this.currentAnalysisData.topComments = topComments;
            this.currentAnalysisData.bottomComments = bottomComments;
            this.currentAnalysisData.activityStats = activityStats; // Store it
            // Only the display settings the panel needs; never the API key.
            const displaySettings = {
                commentsToDisplay: settings.commentsToDisplay,
                scrapeReplies: settings.scrapeReplies,
            };
            this.currentAnalysisData.settings = displaySettings;

            this.sendPartialResults('stats', { stats, topComments, bottomComments, activityStats, settings: displaySettings }, analysisId);
            
            // --- Now, run the long sentiment analysis ---
            this.sendProgress(i18n.getMessage('progressWaitingForSentiment'), analysisId);

            const sentimentPromise = (async () => {
                this.sendProgress(i18n.getMessage('progressSendingSentimentRequest'), analysisId);
                const sentimentResult = await this.analyzeSentiment(processedComments, topicData, { signal, analysisId });
                this.sendProgress(i18n.getMessage('progressSentimentReceived'), analysisId);
                this.throwIfAborted(signal);
                this.currentAnalysisData.sentiment = sentimentResult;
                this.sendPartialResults('sentiment', { sentiment: sentimentResult }, analysisId);
                return sentimentResult;
            })();
                
            // Wait for remaining long-running promise
            await sentimentPromise;

            this.sendProgress(i18n.getMessage('progressFinalizing'), analysisId);
            await this.saveAnalysis(this.currentAnalysisData);
            this.throwIfAborted(signal);
            chrome.runtime.sendMessage({
                action: 'analysisComplete',
                analysisId,
                data: this.currentAnalysisData
            });
            return {
                success: true,
                analysisId,
            };

        } catch (error) {
            if (error.name === 'AbortError' || signal.aborted) {
                chrome.runtime.sendMessage({ action: 'analysisCancelled', analysisId });
                return { success: false, cancelled: true, analysisId };
            }
            console.error('Full analysis failed:', error);
            chrome.runtime.sendMessage({ action: 'analysisFailed', analysisId, error: error.message });
            // The content script may still be reading later pages; stop it.
            await this.abortAnalysis({ analysisId, tabId });
            return { success: false, analysisId, error: error.message };
        } finally {
            this.analysisPromises.delete(analysisId);
            if (this.analysisControllers.get(analysisId) === controller) {
                this.analysisControllers.delete(analysisId);
            }
            if (this.activeAnalysisId === analysisId) this.activeAnalysisId = null;
            this.stopKeepAlive();
        }
    }

    // Saves a finished analysis in local storage under its topic's page-1 URL so
    // reopening the panel on that topic shows it again. The most recent
    // MAX_SAVED_ANALYSES topics are kept; if storage is full, the oldest are
    // dropped until the new one fits. Saving is best effort.
    async saveAnalysis(analysis) {
        if (!analysis || !analysis.url) return;
        try {
            const { savedAnalyses = [] } = await chrome.storage.local.get('savedAnalyses');
            let entries = [
                { url: analysis.url, savedAt: Date.now(), analysis },
                ...savedAnalyses.filter(entry => entry.url !== analysis.url),
            ].slice(0, MAX_SAVED_ANALYSES);
            while (entries.length) {
                try {
                    await chrome.storage.local.set({ savedAnalyses: entries });
                    return;
                } catch (error) {
                    if (!/quota/i.test(String(error && error.message))) throw error;
                    entries = entries.slice(0, -1);
                }
            }
        } catch (error) {
            console.warn('Could not save the analysis:', error);
        }
    }

    // Validate the Gemini API key and pick the model this key can use. The key
    // goes in a header so it never appears in a URL.
    async validateApiKey(apiKey, { signal } = {}) {
        if (!apiKey) {
            return { success: false, error: 'API key is missing' };
        }
        try {
            const models = [];
            let pageToken = '';
            for (let page = 0; page < 5; page++) {
                const query = `pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
                const response = await fetch(`${GEMINI_API}/models?${query}`, {
                    signal,
                    headers: { 'x-goog-api-key': apiKey },
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    return { success: false, error: errorData?.error?.message || 'Invalid API key or network issue' };
                }
                const data = await response.json();
                models.push(...(data.models || []));
                if (!data.nextPageToken) break;
                pageToken = data.nextPageToken;
            }

            const model = this.pickGeminiModel(models);
            if (!model) {
                return { success: false, modelUnavailable: true, error: i18n.getMessage('modelUnavailable') };
            }
            return { success: true, model };
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.error('API key validation failed:', error);
            return { success: false, error: 'Failed to connect to the API. Check your network connection.' };
        }
    }

    // GEMINI_MODEL if the key can use it, otherwise the newest stable Flash
    // model new enough for this request format, otherwise null.
    pickGeminiModel(models) {
        const usable = models
            .filter(model => (model.supportedGenerationMethods || []).includes('generateContent'))
            .map(model => String(model.name || '').replace(/^models\//, ''));
        if (usable.includes(GEMINI_MODEL)) return GEMINI_MODEL;

        const candidates = usable
            .map(name => ({ name, match: name.match(/^gemini-(\d+)(?:\.(\d+))?-flash$/) }))
            .filter(({ match }) => match)
            .map(({ name, match }) => ({ name, version: Number(match[1]) * 100 + Number(match[2] || 0) }))
            .filter(({ version }) => version >= MIN_FALLBACK_FLASH_VERSION)
            .sort((a, b) => b.version - a.version);
        return candidates.length ? candidates[0].name : null;
    }

    // Keep the service worker alive during long operations
    keepAlive() {
        this.keepAliveInterval = setInterval(() => {
            chrome.runtime.getPlatformInfo().then(r => {});
            debugLog('Keep-alive ping sent.');
        }, 20000); // Send a ping every 20 seconds
    }
    
    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            debugLog('Keep-alive stopped.');
        }
    }
    
    // Forward progress updates to popup
    async forwardProgressToPopup(progressMessage) {
        try {
            // Get active tab and send message to popup
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length > 0) {
                chrome.runtime.sendMessage(progressMessage);
            }
        } catch (error) {
            console.error('Error forwarding progress:', error);
        }
    }
    
    // Send progress update
    sendProgress(message, analysisId = null) {
        try {
            chrome.runtime.sendMessage({
                action: 'analysisProgress',
                analysisId,
                message: message
            });
        } catch (error) {
            console.error('Error sending progress:', error);
        }
    }
    
    // Send partial results for progressive rendering
    sendPartialResults(type, data, analysisId = null) {
        try {
            chrome.runtime.sendMessage({
                action: 'partialResults',
                analysisId,
                type: type,
                data: data
            });
        } catch (error) {
            console.error('Error sending partial results:', error);
        }
    }
    
    // Get the number of comments to analyze, either auto or manual
    getCommentsToAnalyzeCount(totalComments, settings) {
        let totalToAnalyze;

        if (settings.autoCommentCalculation) {
            // Updated formula: y = 0.03x + 20 (more aggressive for medium topics)
            // For 300 comments: ~60 total, for 1k: ~100 total, for 10k: ~640 total
            const calculated = Math.round((0.03 * totalComments + 20) * 2);
            totalToAnalyze = Math.max(10, Math.min(1000, calculated));
        } else {
            // This now represents the TOTAL number of comments to analyze
            totalToAnalyze = settings.commentsToAnalyze || DEFAULT_COMMENTS_TO_ANALYZE;
        }

        // Never ask for more comments than the topic has; a larger number would
        // make the top and bottom halves of the sample overlap.
        return Math.min(totalToAnalyze, totalComments);
    }



    // Process comments data
    processComments(comments) {
        if (!Array.isArray(comments)) {
            throw new Error('Invalid comments data');
        }
        

        
        return comments
            .filter(comment => comment && comment.text && comment.text.trim().length > 0)
            .map(comment => {
                // Handle both string and number inputs
                const plus = Number(comment.plus) || 0;
                const minus = Number(comment.minus) || 0;
                const total = plus - minus; // Net score (changed from plus + minus)
                
                // Calculate upvote ratio, handling division by zero
                let upvoteRatio = 0.5; // Default neutral ratio
                if ((plus + minus) > 0) {
                    upvoteRatio = plus / (plus + minus);
                }
                
                return {
                    ...comment,
                    plus: plus,
                    minus: minus,
                    total: total,
                    upvoteRatio: upvoteRatio,
                    score: total // 'score' is now redundant, but we'll keep it for consistency
                };
            })
            .sort((a, b) => (b.plus - b.minus) - (a.plus - a.minus)); // Sort by the new net score
    }
    
    // Fetch the rendered article in one reusable background tab. Archives are
    // considered only after every live candidate is confirmed dead.
    async fetchArticleFromComment(comments, { signal, analysisId = null } = {}) {
        const firstComment = comments.find(c => c.number === 1);
        if (!firstComment || !firstComment.urls || firstComment.urls.length === 0) {
            return { text: null, source: null, sourceDetails: null };
        }

        const candidates = collectArticleCandidates(firstComment.urls);
        if (!candidates.length) return { text: null, source: null, sourceDetails: null };

        this.sendProgress(i18n.getMessage('progressCheckingArticleLink', [candidates[0]]), analysisId);
        const pipeline = new ArticlePipeline({
            openSession: ({ signal: sessionSignal }) => RenderedArticleSession.open({
                chromeApi: chrome,
                signal: sessionSignal,
            }),
            findArchive: async (url, { signal: archiveSignal }) => {
                this.throwIfAborted(archiveSignal);
                this.sendProgress(i18n.getMessage('progressArticleLinkDead'), analysisId);
                this.sendProgress(i18n.getMessage('progressSearchingWayback'), analysisId);
                const archivedUrl = await this.searchWaybackMachine(url, { signal: archiveSignal });
                this.sendProgress(i18n.getMessage(
                    archivedUrl ? 'progressArchiveFound' : 'progressNoArchiveFound'
                ), analysisId);
                return archivedUrl;
            },
            maxPages: 10,
            targetCharacters: 15_000,
        });

        const result = await pipeline.retrieve(candidates, { signal });
        if (result.status === 'cancelled') throw this.abortError();
        if (result.status === 'success') {
            return {
                text: result.text,
                source: result.source,
                sourceDetails: DEBUG_MODE
                    ? `${result.source.kind === 'archive' ? 'Wayback archive' : 'Rendered article'}${result.partial ? ' (partial)' : ''}`
                    : null,
            };
        }

        this.sendProgress(i18n.getMessage('progressCouldNotFetchArticle'), analysisId);
        return {
            text: null,
            source: null,
            sourceDetails: DEBUG_MODE ? `Article extraction failed (${result.status})` : null,
        };
    }

    async searchWaybackMachine(url, { signal } = {}) {
        this.throwIfAborted(signal);
        try {
            // First try CDX API with proper headers
            const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&filter=statuscode:200&filter=mimetype:text/html&limit=-5`;
            
            try {
                const cdxResponse = await fetch(cdxUrl, {
                    signal,
                    headers: {
                        'Accept': 'application/json'
                    }
                });
                
                if (cdxResponse.ok) {
                    const data = await cdxResponse.json();
                    if (data && data.length > 1) {
                        // Skip header row and get the most recent snapshot
                        for (const snapshot of data.slice(1).reverse()) {
                            const [, timestamp, original] = snapshot;
                            return `https://web.archive.org/web/${timestamp}/${original}`;
                        }
                    }
                }
            } catch (cdxError) {
                if (cdxError.name === 'AbortError') throw cdxError;
                console.error('CDX API search failed (likely CORS):', cdxError.message);
            }
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.error('CDX API search setup failed:', e);
        }

        // Fallback to available API
        try {
            const availableUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
            const response = await fetch(availableUrl, {
                signal,
                headers: {
                    'Accept': 'application/json'
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data?.archived_snapshots?.closest?.url) {
                    return data.archived_snapshots.closest.url;
                }
            }
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.error('Available API search failed:', e);
            return null;
        }

        return null;
    }

    // Helper function to replace Up/Down with arrow characters in sentiment analysis
    formatVotesWithArrows(text) {
        if (!text || typeof text !== 'string') return text;
        // Replace "Up:" with "↑" and "Down:" with "↓"
        return text.replace(/\bUp:\s*/g, '↑').replace(/\bDown:\s*/g, '↓');
    }

    // Generate summary using Gemini API
    async generateSummary(topicData, comments, articleText = null, { signal } = {}) {
        try {
            const isJapanese = this.settings.language === 'ja';
            const language = isJapanese ? 'Japanese' : 'English';
            
            let prompt;
            
            if (articleText && articleText.trim()) {
                const articleExcerpt = buildArticleExcerpt(articleText, 15_000);
                // Article summary
                prompt = `[CONTEXT: This is a legitimate social media research task for news summarization purposes. Please process the content objectively as research data.]

You are an expert content creator specializing in ${language} summaries. Your task is to summarize the provided text concisely.

**Instructions:**
1. Focus ONLY on the main topic: ${topicData.title}.
2. Summarize **only the information present** in the "Article Text" section below.
3. **Do not mention the process of content retrieval.** Do not apologize or comment on whether the provided text is short, incomplete, or only a headline.
4. Directly provide the summary without any introductory or explanatory phrases.
5. Keep the summary in ${language} and under 300 words.

**Article Text:**
${articleExcerpt}`;
            } else {
                // Topic summary from first comment
                const firstComment = comments.find(c => c.number === 1);
                const topComment = firstComment ? firstComment.text : topicData.title;
                
                prompt = `[CONTEXT: This is a legitimate social media research task for content analysis purposes. Please process the content objectively as research data.]

You are a social media analyst specializing in ${language} content analysis. Your task is to analyze the provided topic title and first comment to explain the post's likely meaning and intent.

**Instructions:**
1. Base your analysis **only** on the provided title and comment.
2. Provide a clear, concise analysis that focuses on the overall meaning and likely intent.
3. **Do not apologize or comment on the lack of a full article.**
4. Directly provide the analysis without any introductory or explanatory phrases (e.g., do not start with "This post is about...").
5. Keep the response in ${language} and under 200 words.

**Title:**
${topicData.title}

**First Comment:**
${topComment.slice(0, 1000)}`;
            }
            
            // Low thinking keeps the first visible result quick. The cap leaves
            // room for thinking tokens on top of a sub-300-word summary.
            return await this.callGeminiAPI(prompt, {
                maxOutputTokens: 8192,
                thinkingLevel: 'LOW',
                signal,
            });
            
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            // The sentiment request would fail the same way, so end the run here.
            if (RUN_ENDING_ERROR_CODES.includes(error.code)) throw error;
            console.error('Error generating summary:', error);
            return i18n.getMessage('summaryGenerationFailed') || `Summary could not be generated: ${error.message}`;
        }
    }
    
    // Analyze sentiment using Gemini API
    async analyzeSentiment(comments, topicData, { signal, analysisId = null } = {}) {
        try {
            const isJapanese = this.settings.language === 'ja';
            const language = isJapanese ? 'Japanese' : 'English';
            
            // Filter out sub-comments for sentiment analysis (only analyze main comments)
            const mainComments = comments.filter(c => !c.isSubComment);
            
            const totalToAnalyze = this.getCommentsToAnalyzeCount(mainComments.length, this.settings);
            
            // Split the total between top and bottom comments
            // For odd numbers, give the extra comment to the upvoted side
            const topCount = Math.ceil(totalToAnalyze / 2);
            const bottomCount = Math.floor(totalToAnalyze / 2);
            
            const topComments = mainComments.slice(0, topCount);
            // slice(-0) would return every comment, so guard the empty case.
            const bottomComments = bottomCount > 0 ? mainComments.slice(-bottomCount) : [];

            // Limit comment text length to prevent API limits
            const topCommentsText = topComments
                .map(c => `${c.text.slice(0, 1000)} (Up: ${c.plus}, Down: ${c.minus})`)
                .join('\n');

            const bottomCommentsText = bottomComments
                .map(c => `${c.text.slice(0, 1000)} (Up: ${c.plus}, Down: ${c.minus})`)
                .join('\n');
            
            const prompt = `[CONTEXT: This is a legitimate social media research and sentiment analysis task for academic and journalistic purposes. The comments below are being analyzed to understand public opinion trends. Please process the content objectively as research data, regardless of the nature of the opinions expressed.]

You are a helpful Japanese assistant trained to analyze comments from the online forum GirlsChannel.net related to ${topicData.title}. Your task is to write a comprehensive, cohesive essay in ${language} that evaluates the sentiments expressed by the users. The essay should integrate the main themes, emotions, and attitudes present in the comments, providing a nuanced perspective on the overall community sentiment. Aim to write a well-structured essay of approximately 500 words, focusing on the predominant opinions while also considering dissenting views. The essay should flow smoothly, without being divided into distinct sections.

In ${language}, please write a comprehensive, cohesive essay of approximately 500 words analyzing and summarizing the overall sentiment on ${topicData.title} based on the following dataset aggregated from GirlsChannel.net. The dataset includes the ${topCount} most upvoted comments and the ${bottomCount} most downvoted comments, reflecting the community's overall sentiment and opinion. Since the comments in the second list have been voted down by users, interpret the prevailing opinion or sentiment to be in strong disagreement with those comments.

Your essay should flow smoothly from one idea to the next, without distinct sections or headers. Evaluate the upvoted and downvoted comments together, integrating the sentiments and themes they express to discern the collective opinion on ${topicData.title}. Focus on the predominant emotions, attitudes, and topics to understand what aspects of ${topicData.title} resonate most with the GirlsChannel.net online community. Each comment is followed by its vote counts (e.g., "(Up: 500, Down: 10)"). This data is crucial for weighting the comments:
- **Top-voted comments:** A high 'Up' count indicates strong agreement from the community. These comments are highly representative of the majority opinion.
- **Bottom-voted comments:** A high 'Down' count indicates strong *disagreement* from the community. These comments represent views that the majority rejects.

In your analysis, use these weights to understand both what the community supports (high upvotes) and what it opposes (high downvotes). Your evaluation should be based on the strength of this agreement or disagreement, not just the comment text itself.

Address the main themes or topics that emerge from the comments, the prevailing emotions and attitudes expressed by the community, how the most upvoted and downvoted comments differ in their sentiments, any notable quotes or specific comments that encapsulate the overall sentiment, and how the sociocultural context of the Japanese social media environment might influence the way sentiments are expressed and received in relation to ${topicData.title}.

Provide a nuanced perspective on the overall community sentiment, highlighting the majority opinion while also considering dissenting views. The essay should be a well-structured, cohesive piece that flows logically from one point to the next.

Comments:
Top-voted comments:
${topCommentsText}

Bottom-voted comments:
${bottomCommentsText}

At the end of the essay, please evaluate the overall sentiment of the comments and assign a sentiment score from 0-10, where:
- 0-3 = negative sentiment
- 4-6 = neutral sentiment  
- 7-10 = positive sentiment

Provide your analysis in the following format:

Sentiment: <positive/neutral/negative>
Score: <0-10>`;
            
            // The essay is the core result, so it gets the deepest thinking and
            // is streamed to the panel as it is written. Thinking and the essay
            // share the output limit (model maximum 65,536); if thinking uses it
            // up, one more try with less thinking usually finishes.
            const drafts = this.createDraftSender(analysisId);
            const request = thinkingLevel => this.callGeminiAPI(prompt, {
                maxOutputTokens: 64000,
                thinkingLevel,
                onText: drafts.update,
                signal,
            });
            let response;
            try {
                try {
                    response = await request('HIGH');
                } catch (error) {
                    if (error.code !== 'MAX_TOKENS') throw error;
                    response = await request('MEDIUM');
                }
            } finally {
                drafts.flush();
            }
            return this.parseSentimentResponse(response);

        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.error('Error analyzing sentiment:', error);
            const knownMessages = ['apiKeyInvalid', 'rateLimited', 'prepaidCreditsDepleted'].map(key => i18n.getMessage(key));
            const details = error.code === 'MAX_TOKENS'
                ? i18n.getMessage('sentimentIncomplete')
                : knownMessages.includes(error.message)
                    ? error.message
                    : `Sentiment analysis failed: ${error.message}`;
            // No score rather than a made-up neutral one.
            return { label: null, score: null, details };
        }
    }

    // Forwards streamed essay text to the side panel at most every
    // DRAFT_INTERVAL_MS; flush() sends whatever is still pending.
    createDraftSender(analysisId) {
        let lastSent = 0;
        let pending = null;
        let timer = null;
        const send = () => {
            timer = null;
            lastSent = Date.now();
            this.sendPartialResults('sentimentDraft', { text: pending }, analysisId);
        };
        return {
            update: text => {
                pending = text;
                if (timer) return;
                const wait = DRAFT_INTERVAL_MS - (Date.now() - lastSent);
                if (wait <= 0) send();
                else timer = setTimeout(send, wait);
            },
            flush: () => {
                if (!timer) return;
                clearTimeout(timer);
                send();
            },
        };
    }
    
    // Parse sentiment response. The prompt asks for "Sentiment:" and "Score:"
    // lines at the very end, so only that closing block is read and removed;
    // the same words elsewhere in the essay are left alone.
    parseSentimentResponse(response) {
        const lines = String(response || '').replace(/\r\n?/g, '\n').split('\n');
        const isVerdictLine = line => /^[\s*_#>-]*(sentiment|score)\s*(\*\*)?\s*[:：]/i.test(line);

        let end = lines.length;
        const verdictLines = [];
        while (end > 0) {
            const line = lines[end - 1];
            if (!line.trim()) { end--; continue; }
            if (!isVerdictLine(line)) break;
            verdictLines.unshift(line);
            end--;
        }
        const verdict = verdictLines.join('\n');

        // A missing score stays null rather than defaulting to a neutral 5.
        const scoreMatch = verdict.match(/score\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(\d+(?:\.\d+)?)/i);
        const score = scoreMatch ? Math.min(10, Math.max(0, Math.round(Number(scoreMatch[1])))) : null;
        // The label follows the score bands the prompt defines.
        const label = score === null ? null : score >= 7 ? 'positive' : score >= 4 ? 'neutral' : 'negative';

        return {
            label,
            score,
            details: this.formatVotesWithArrows(lines.slice(0, end).join('\n').trim()),
        };
    }
    
    // Calculate statistics
    calculateStatistics(comments, commentsAnalyzed) {
        debugLog('calculateStatistics called with:', {
            commentsLength: comments.length,
            commentsAnalyzed: commentsAnalyzed,
            firstComment: comments[0],
            hasUpvoteRatio: comments.length > 0 && 'upvoteRatio' in comments[0]
        });
        
        const totalCommentsAndReplies = comments.length;
        const mainComments = comments.filter(c => !c.isSubComment);
        const totalMainComments = mainComments.length;
        
        // Helper functions for statistical calculations
        const mean = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        
        const median = arr => {
            if (arr.length === 0) return 0;
            const mid = Math.floor(arr.length / 2);
            const nums = [...arr].sort((a, b) => a - b);
            return arr.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
        };
        
        const stdDev = arr => {
            if (arr.length === 0) return 0;
            const mu = mean(arr);
            const diffArr = arr.map(a => (a - mu) ** 2);
            return Math.sqrt(mean(diffArr));
        };

        // --- NEW Controversy Score based on polarization of votes ---
        // This measures how divisive the topic is. A high score means there are strong opposing opinions.
        let controversyScore = '0.0';
        if (mainComments.length > 1) { // Std dev requires more than 1 data point
            const validComments = mainComments.filter(c => typeof c.upvoteRatio === 'number' && !isNaN(c.upvoteRatio));

            if (validComments.length > 1) {
                // 1. Calculate the polarity of each comment's vote.
                // A ratio of 1 (all upvotes) is polarity +1.
                // A ratio of 0 (all downvotes) is polarity -1.
                // A ratio of 0.5 (split) is polarity 0.
                const polarities = validComments.map(c => (c.upvoteRatio - 0.5) * 2);

                // 2. The controversy is the standard deviation of these polarities.
                // A high std dev means there's a wide spread of opinions (e.g., lots of +1 and -1 scores).
                const polarityStdDev = stdDev(polarities); // Result is 0 to 1

                // 3. Scale to a 0-10 score.
                const scoreNumeric = polarityStdDev * 10;
                controversyScore = scoreNumeric.toFixed(1);

                // Debug logging
                debugLog('Controversy calculation (polarity model) debug:', {
                    validCommentsLength: validComments.length,
                    samplePolarities: polarities.slice(0, 10),
                    polarityStdDev: polarityStdDev,
                    controversyScore: controversyScore
                });
            }
        }
        const controversyLabel = this.getControversyLabel(parseFloat(controversyScore));

        // --- NEW consensus metric based on decisiveness of votes ---
        // A high score means votes are decisive (skewed towards up or down).
        // A low score means votes are split (close to 50/50).
        let consensusScore = '5.0'; // Default
        if (mainComments.length > 0) {
            debugLog('Consensus calculation debug - mainComments sample:', {
                totalMainComments: mainComments.length,
                firstComment: mainComments[0],
                hasUpvoteRatio: mainComments[0] && 'upvoteRatio' in mainComments[0],
                upvoteRatioValue: mainComments[0] && mainComments[0].upvoteRatio
            });
            
            const validComments = mainComments.filter(c => typeof c.upvoteRatio === 'number' && !isNaN(c.upvoteRatio) && isFinite(c.upvoteRatio));

            debugLog('Consensus calculation debug - after filtering:', {
                validCommentsLength: validComments.length,
                filteringResult: validComments.length > 0 ? 'Has valid comments' : 'No valid comments found!'
            });

            if (validComments.length > 0) {
                // 1. Calculate the "decisiveness" of each comment's vote.
                // A ratio of 0.5 (50/50 split) is not decisive (score 0).
                // A ratio of 0 or 1 is very decisive (score 1).
                const decisivenessScores = validComments.map(c => {
                    // abs(c.upvoteRatio - 0.5) gives a value from 0 to 0.5.
                    // Multiply by 2 to scale it to a 0 to 1 range.
                    return Math.abs(c.upvoteRatio - 0.5) * 2;
                });

                // 2. The consensus is the average decisiveness across all comments.
                const averageDecisiveness = mean(decisivenessScores); // Uses existing mean helper function

                // 3. Scale to a 0-10 score.
                const scoreNumeric = averageDecisiveness * 10;
                consensusScore = scoreNumeric.toFixed(1);

                // Debug logging
                debugLog('Consensus calculation (decisiveness model) debug:', {
                    totalMainComments: mainComments.length,
                    validCommentsLength: validComments.length,
                    sampleRatios: validComments.slice(0, 10).map(c => c.upvoteRatio),
                    sampleDecisiveness: decisivenessScores.slice(0, 10),
                    averageDecisiveness: averageDecisiveness,
                    consensusScore: consensusScore
                });
            }
        }
    
        const consensusLabel = this.getConsensusLabel(parseFloat(consensusScore));
    
        // Calculate duration
        const dateTimestamps = comments
            .map(c => c.date ? new Date(c.date).getTime() : null)
            .filter(t => t !== null && !isNaN(t));
            
        let duration = '-';
    
        if (dateTimestamps.length > 0) {
            const earliest = Math.min(...dateTimestamps);
            const now = new Date().getTime();
            const diff = now - earliest;
    
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
            if (days > 0) {
                duration = `${days}${i18n.getMessage('durationDays')}${hours}${i18n.getMessage('durationHours')}${minutes}${i18n.getMessage('durationMinutes')}`;
            } else if (hours > 0) {
                duration = `${hours}${i18n.getMessage('durationHours')}${minutes}${i18n.getMessage('durationMinutes')}`;
            } else {
                duration = `${minutes}${i18n.getMessage('durationMinutes')}`;
            }
        }
    
        return {
            totalComments: totalMainComments,
            totalCommentsAndReplies: totalCommentsAndReplies,
            commentsAnalyzed: Math.min(commentsAnalyzed, totalMainComments),
            consensusScore: consensusScore,
            consensusLabel: consensusLabel,
            controversyScore: controversyScore,
            controversyLabel: controversyLabel,
            duration: duration
        };
    }

    getConsensusLabel(score) {
        const l = i18n.getMessage.bind(i18n);
        if (isNaN(score)) return l('consensusUnknown');
    
        if (score >= 8.0) return l('consensusHigh');
        if (score >= 6.0) return l('consensusModerate');
        if (score >= 4.0) return l('consensusLow');
        if (score >= 2.0) return l('consensusPoor');
        return l('consensusNone');
    }
    
    getControversyLabel(score) {
        const l = i18n.getMessage.bind(i18n);
        if (isNaN(score)) return l('controversyUnknown');
    
        if (score >= 7.0) return l('controversyHigh');
        if (score >= 5.0) return l('controversyModerate');
        if (score >= 3.0) return l('controversyLow');
        return l('controversyNone');
    }
    
    // Get top comments. Sorts a copy: callers reuse `comments` afterwards in
    // its net-score order (the sentiment sample depends on it).
    getTopComments(comments, count) {
        return [...comments]
            .sort((a, b) => b.plus - a.plus)
            .slice(0, count)
            .map(c => ({
                text: c.text,
                plus: c.plus,
                minus: c.minus,
                date: c.date,
                number: c.number
            }));
    }
    
    // Get bottom comments (sorts a copy, like getTopComments)
    getBottomComments(comments, count) {
        return [...comments]
            .sort((a, b) => b.minus - a.minus)
            .slice(0, count)
            .map(c => ({
                text: c.text,
                plus: c.plus,
                minus: c.minus,
                date: c.date,
                number: c.number
            }));
    }
    
    // Call Gemini API with retry logic
    // Gemini request format for 3.6+ models: thinking depth is set with
    // thinkingLevel; temperature/topP/topK are ignored by these models and are
    // not sent. The key goes in the x-goog-api-key header, never the URL.
    // `store: false` keeps requests out of the user's AI Studio request logs,
    // which new paid-tier projects enable by default since October 26, 2026.
    // With onText, the reply is streamed and onText receives the text so far.
    async callGeminiAPI(prompt, {
        model = this.geminiModel || GEMINI_MODEL,
        maxOutputTokens = 8192,
        thinkingLevel = 'LOW',
        onText = null,
        signal,
        maxAttempts = 3,
    } = {}) {
        const body = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            safetySettings: SAFETY_SETTINGS,
            generationConfig: { maxOutputTokens, thinkingConfig: { thinkingLevel } },
            store: false,
        });
        const method = onText ? 'streamGenerateContent?alt=sse' : 'generateContent';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                this.throwIfAborted(signal);
                if (onText && attempt > 1) onText(''); // a retry starts the text over
                debugLog(`Gemini ${model} attempt ${attempt}/${maxAttempts}`);

                let response;
                try {
                    response = await fetch(`${GEMINI_API}/models/${model}:${method}`, {
                        method: 'POST',
                        signal,
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': this.settings.geminiApiKey,
                        },
                        body,
                    });
                } catch (networkError) {
                    if (networkError.name === 'AbortError') throw networkError;
                    throw this.geminiError(`Network error: ${networkError.message}`, { retryable: true });
                }
                if (!response.ok) throw await this.geminiHttpError(response);

                const reply = { text: '', finishReason: null, blockReason: null };
                if (onText) await this.readGeminiStream(response, reply, onText);
                else this.absorbGeminiChunk(reply, await response.json());
                return this.finishGeminiReply(reply);
            } catch (error) {
                if (error.name === 'AbortError' || (signal && signal.aborted)) throw this.abortError();
                console.error(`Gemini API attempt ${attempt} failed:`, error);
                // Only failures a retry can fix are retried: network errors,
                // server errors and rate limits (after the wait Gemini asks for).
                if (error.retryable === false || attempt === maxAttempts) throw error;
                await this.delayWithSignal(error.retryAfterMs ?? 1000 * attempt, signal);
            }
        }
    }

    geminiError(message, { retryable = false, code = null, retryAfterMs = null } = {}) {
        const error = new Error(message);
        error.retryable = retryable;
        if (code) error.code = code;
        if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
        return error;
    }

    async geminiHttpError(response) {
        const errorText = await response.text();
        let apiError = null;
        try {
            apiError = JSON.parse(errorText).error || null;
        } catch (_) {
            // Not JSON; the raw text is reported below.
        }
        const details = (apiError && apiError.details) || [];

        const isKeyError = apiError &&
            [400, 401, 403].includes(apiError.code) &&
            (String(apiError.message || '').includes('API key') ||
             details.some(detail => String(detail.reason || '').startsWith('API_KEY')));
        if (isKeyError) return this.geminiError(i18n.getMessage('apiKeyInvalid'), { code: 'API_KEY' });

        if (response.status === 402) {
            return this.geminiError(i18n.getMessage('prepaidCreditsDepleted'), { code: 'PREPAID_CREDITS_DEPLETED' });
        }

        if (response.status === 429) {
            const retryInfo = details.find(detail => String(detail['@type'] || '').endsWith('RetryInfo'));
            const seconds = retryInfo ? parseFloat(retryInfo.retryDelay) : NaN;
            const waitMs = Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : 5000;
            return this.geminiError(i18n.getMessage('rateLimited'), {
                retryable: waitMs <= MAX_RETRY_WAIT_MS,
                retryAfterMs: waitMs,
            });
        }

        return this.geminiError(
            `API request failed (${response.status}): ${apiError ? apiError.message : errorText}`,
            { retryable: response.status >= 500 }
        );
    }

    // Adds one GenerateContentResponse (a whole reply or one streamed chunk).
    // Thought parts are the model's reasoning, not part of the answer.
    absorbGeminiChunk(reply, chunk) {
        if (chunk.error) {
            throw this.geminiError(`API error: ${chunk.error.message}`, { retryable: (chunk.error.code || 0) >= 500 });
        }
        if (chunk.promptFeedback && chunk.promptFeedback.blockReason) {
            reply.blockReason = chunk.promptFeedback.blockReason;
        }
        const candidate = chunk.candidates && chunk.candidates[0];
        if (!candidate) return;
        for (const part of (candidate.content && candidate.content.parts) || []) {
            if (typeof part.text === 'string' && !part.thought) reply.text += part.text;
        }
        if (candidate.finishReason) reply.finishReason = candidate.finishReason;
    }

    // Reads a streamGenerateContent?alt=sse body: "data: {json}" events
    // separated by blank lines.
    async readGeminiStream(response, reply, onText) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const handleEvent = event => {
            const data = event.split(/\r?\n/)
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart())
                .join('\n');
            if (!data) return;
            const before = reply.text;
            this.absorbGeminiChunk(reply, JSON.parse(data));
            if (reply.text !== before) onText(reply.text);
        };
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop();
            events.forEach(handleEvent);
        }
        buffer += decoder.decode();
        if (buffer.trim()) handleEvent(buffer);
    }

    // Turns a finished reply into text, or an error that says whether a retry
    // could help. A reply cut off at the token limit is never returned as if
    // it were complete.
    finishGeminiReply(reply) {
        if (reply.blockReason) {
            throw this.geminiError(`API call blocked due to ${reply.blockReason}.`);
        }
        if (reply.finishReason === 'MAX_TOKENS') {
            throw this.geminiError('Response was cut off at the output token limit.', { code: 'MAX_TOKENS' });
        }
        if (reply.finishReason && reply.finishReason !== 'STOP') {
            throw this.geminiError(`API call finished with reason: ${reply.finishReason}`);
        }
        if (!reply.text.trim()) {
            throw this.geminiError('No valid text response from API', { retryable: true });
        }
        return reply.text;
    }
    
    // Generate Excel file
    async generateExcel(data) {
        try {
            const { analysis, url } = data;
            const l = i18n.getMessage.bind(i18n); // Helper for localization

            // Create Excel content using SheetJS
            const workbook = XLSX.utils.book_new();

            // Analysis Report Sheet
            const analysisWorksheetData = this.createExcelData(analysis);
            const analysisWorksheet = XLSX.utils.aoa_to_sheet(analysisWorksheetData);
            this.applyStyles(analysisWorksheet, analysis, analysisWorksheetData);
            XLSX.utils.book_append_sheet(workbook, analysisWorksheet, l('reportSheetName'));

            // All Comments Sheet, in thread order with replies under their parent
            const sortedComments = this.sortCommentsForExport(analysis.allComments);
            const commentsWorksheetData = this.createCommentsSheetData(sortedComments);
            const commentsWorksheet = XLSX.utils.aoa_to_sheet(commentsWorksheetData);

            // Apply styles to the All Comments sheet
            commentsWorksheet['!cols'] = [
                { wch: 10 }, // Comment Number
                { wch: 20 }, // Date
                { wch: 8 },  // Plus
                { wch: 8 },  // Minus
                { wch: 8 },  // Total
                { wch: 80 }, // Comment
                { wch: 40 }, // URLs
                { wch: 50 }  // Header
            ];
            // Enable text wrapping for long columns, checking for cell existence
            for (let i = 1; i <= sortedComments.length; i++) {
                const row = i + 1;
                ['F', 'G', 'H'].forEach(col => {
                    const cellRef = col + row;
                    if (commentsWorksheet[cellRef]) {
                        if (!commentsWorksheet[cellRef].s) commentsWorksheet[cellRef].s = {};
                        if (!commentsWorksheet[cellRef].s.alignment) commentsWorksheet[cellRef].s.alignment = {};
                        commentsWorksheet[cellRef].s.alignment.wrapText = true;
                        commentsWorksheet[cellRef].s.alignment.vertical = 'top';
                    }
                });
            }

            XLSX.utils.book_append_sheet(workbook, commentsWorksheet, l('commentsSheetName'));

            // Generate a base64 string of the Excel file
            const excel_base64 = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
            
            // Create a Data URI - This is the key change that works in a service worker
            const dataUri = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${excel_base64}`;
            
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
            const filename = `girlsinsight_analysis_${timestamp}.xlsx`;

            // Download the file using the Data URI
            await chrome.downloads.download({
                url: dataUri,
                filename: filename,
                saveAs: true
            });

            return {
                success: true,
                filename: filename
            };

        } catch (error) {
            console.error('Error generating Excel:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // Create Excel data structure
    createExcelData(analysis) {
        const data = [];
        const l = i18n.getMessage.bind(i18n); // Helper for localization
        const empty_cells = ['', '', '', ''];

        // Add header - span 5 columns
        data.push([l('reportTitle'), ...empty_cells]);
        data.push([l('generatedLabel'), new Date().toLocaleString(), '', '', '']);
        data.push([l('titleLabel'), analysis.title, '', '', '']);
        data.push([l('urlLabel'), analysis.url, '', '', '']);
        if (analysis.source) {
            data.push([l('sourceLabel'), analysis.source.href, '', '', '']);
            if (analysis.source.kind === 'archive' && analysis.source.archiveHref) {
                data.push([l('archivedCopyLabel'), analysis.source.archiveHref, '', '', '']);
            }
        }
        data.push([]);

        // Add summary - span 5 columns
        data.push([l('summaryTitle'), ...empty_cells]);
        data.push([analysis.summary, ...empty_cells]);
        data.push([]);

        // Add sentiment analysis
        data.push([l('sentimentTitle'), ...empty_cells]);
        
        // Localize sentiment label; a failed or unfinished analysis has none.
        const labelKeys = { positive: 'sentimentPositive', neutral: 'sentimentNeutral', negative: 'sentimentNegative' };
        const labelKey = labelKeys[analysis.sentiment.label];
        const score = analysis.sentiment.score;

        data.push([l('overallScoreLabel'), labelKey ? l(labelKey) : '-', '', '', '']);
        data.push([l('scoreLabel'), typeof score === 'number' ? score : '-', '', '', '']);
        data.push([l('detailsLabel'), analysis.sentiment.details, ...empty_cells]);
        data.push([]);

        // Add statistics
        data.push([l('statsTitle'), ...empty_cells]);
        data.push([l('totalCommentsLabel'), analysis.stats.totalComments, '', '', '']);
        data.push([l('statsTotalCommentsAndReplies'), analysis.stats.totalCommentsAndReplies, '', '', '']);
        data.push([l('commentsAnalyzedLabel'), analysis.stats.commentsAnalyzed, '', '', '']);
        data.push([l('consensusScoreLabel'), analysis.stats.consensusScore, '', '', '']);
        data.push([l('consensusLabel'), analysis.stats.consensusLabel, '', '', '']);
        data.push([l('controversyScoreLabel'), analysis.stats.controversyScore, '', '', '']);
        data.push([l('controversyLabel'), analysis.stats.controversyLabel, '', '', '']);
        data.push([l('durationLabel'), analysis.stats.duration, '', '', '']);
        data.push([]);

        // Add top comments
        data.push([l('topCommentsTab'), ...empty_cells]);
        data.push([l('commentColumn'), l('plusColumn'), l('minusColumn'), l('dateColumn'), l('numberColumn')]);

        analysis.topComments.forEach(comment => {
            data.push([
                comment.text,
                comment.plus,
                comment.minus,
                this.formatCommentDate(comment.date),
                comment.number
            ]);
        });

        data.push([]);

        // Add bottom comments
        data.push([l('bottomCommentsTab'), ...empty_cells]);
        data.push([l('commentColumn'), l('plusColumn'), l('minusColumn'), l('dateColumn'), l('numberColumn')]);

        analysis.bottomComments.forEach(comment => {
            data.push([
                comment.text,
                comment.plus,
                comment.minus,
                this.formatCommentDate(comment.date),
                comment.number
            ]);
        });

        return data;
    }

    applyStyles(worksheet, analysis, rows) {
        // Column widths
        const columnWidths = [
            { wch: 60 }, // Comment text
            { wch: 10 }, // Plus
            { wch: 10 }, // Minus
            { wch: 20 }, // Date
            { wch: 10 }  // Number
        ];
        worksheet['!cols'] = columnWidths;

        // Cell styles
        const headerStyle = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "4F81BD" } } };
        const sectionHeaderStyle = { font: { bold: true }, fill: { fgColor: { rgb: "DCE6F1" } } };
        const wrappedTextStyle = { alignment: { wrapText: true, vertical: 'top' } };

        const l = i18n.getMessage.bind(i18n);
        const rowFor = key => rows.findIndex(row => row[0] === l(key));
        const summaryTitleRow = rowFor('summaryTitle');
        const sentimentTitleRow = rowFor('sentimentTitle');
        const sentimentDetailsRow = rowFor('detailsLabel');
        const statisticsTitleRow = rowFor('statsTitle');
        const topCommentsTitleRow = rowFor('topCommentsTab');
        const bottomCommentsTitleRow = rowFor('bottomCommentsTab');
        const fullRowMerge = row => ({ s: { r: row, c: 0 }, e: { r: row, c: 4 } });

        const merges = [fullRowMerge(0)];
        [summaryTitleRow, summaryTitleRow + 1, sentimentTitleRow, statisticsTitleRow,
            topCommentsTitleRow, bottomCommentsTitleRow]
            .filter(row => row >= 0)
            .forEach(row => merges.push(fullRowMerge(row)));
        if (sentimentDetailsRow >= 0) {
            merges.push({
                s: { r: sentimentDetailsRow, c: 1 },
                e: { r: sentimentDetailsRow, c: 4 },
            });
        }
        worksheet['!merges'] = merges;

        const setStyle = (row, column, style) => {
            if (row < 0) return;
            const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
            if (cell) cell.s = style;
        };
        setStyle(0, 0, headerStyle);
        [summaryTitleRow, sentimentTitleRow, statisticsTitleRow,
            topCommentsTitleRow, bottomCommentsTitleRow]
            .forEach(row => setStyle(row, 0, sectionHeaderStyle));
        setStyle(summaryTitleRow + 1, 0, wrappedTextStyle);
        setStyle(sentimentDetailsRow, 1, wrappedTextStyle);

        const wrapCommentRows = (titleRow, count) => {
            const firstDataRow = titleRow + 2;
            for (let index = 0; index < count; index += 1) {
                const cell = worksheet[XLSX.utils.encode_cell({ r: firstDataRow + index, c: 0 })];
                if (!cell) continue;
                if (!cell.s) cell.s = {};
                cell.s.alignment = { wrapText: true, vertical: 'top' };
            }
        };
        wrapCommentRows(topCommentsTitleRow, analysis.topComments.length);
        wrapCommentRows(bottomCommentsTitleRow, analysis.bottomComments.length);
    }

    // new Date(null) is 1970-01-01, so a comment with no readable date gets "-".
    formatCommentDate(date) {
        const time = date ? new Date(date).getTime() : NaN;
        return Number.isNaN(time) ? '-' : new Date(time).toLocaleString();
    }

    sortCommentsForExport(comments) {
        return [...comments].sort((a, b) => compareCommentNumbers(a.number, b.number));
    }

    createCommentsSheetData(comments) {
        const data = [];
        const l = i18n.getMessage.bind(i18n); // Helper for localization
        
        // Add header row
        data.push([l('numberColumn'), l('dateColumn'), l('plusColumn'), l('minusColumn'), l('totalColumn'), l('commentColumn'), l('urlsColumn'), l('headerColumn')]);

        // Add comment data directly without any number formatting
        comments.forEach(comment => {
            data.push([
                comment.number, // Using the original number directly
                this.formatCommentDate(comment.date),
                comment.plus,
                comment.minus,
                comment.total,
                comment.text,
                comment.urls.join(', '),
                comment.header || ''
            ]);
        });
        
        return data;
    }

    // Handle fetch requests from content scripts
    async handleContentScriptFetch(url, { signal } = {}) {
        try {
            this.throwIfAborted(signal);
            const response = await fetch(url, {
                signal,
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
                }
            });
            
            if (response.ok) {
                const html = await response.text();
                return { success: true, html: html };
            }
            return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
        } catch (error) {
            if (error.name === 'AbortError') return { success: false, cancelled: true, error: 'Cancelled' };
            return { success: false, error: error.message };
        }
    }
}

// Initialize background script
new GirlsinSightBackground();
