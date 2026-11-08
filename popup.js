// Popup JavaScript - Fully Localized

const i18n = {
    messages: {},
    async init() {
        try {
            const result = await chrome.storage.sync.get('language');
            const lang = result.language || 'ja'; // Default to Japanese
            const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch: ${response.statusText}`);
            }
            this.messages = await response.json();
        } catch (error) {
            console.error('Error initializing localization, falling back to English:', error);
            try {
                const url = chrome.runtime.getURL(`_locales/en/messages.json`);
                const response = await fetch(url);
                this.messages = await response.json();
            } catch (fallbackError) {
                console.error('Failed to load fallback English localization:', fallbackError);
                this.messages = {}; // No localizations available
            }
        }
    },
    getMessage(key, replacements) {
        const messageData = this.messages[key];
        if (!messageData) {
            console.warn(`Missing localization for key: ${key}`);
            return key; // Fallback to the key itself
        }
        let message = messageData.message;
        if (replacements && Array.isArray(replacements)) {
            replacements.forEach((rep, i) => {
                message = message.replace(`$${i + 1}`, rep);
            });
        }
        return message;
    }
};

// The status line for an analysis that failed to run. A message from the
// service worker is already written for the user (a used-up prepaid project,
// a busy Gemini, a missing model...) and is shown word for word; only
// unexpected errors, such as a lost connection, get a generic message.
function analysisErrorMessage(error, analysisResponse, getMessage) {
    if (analysisResponse && analysisResponse.error) return analysisResponse.error;
    const text = String((error && error.message) || '');
    if (text.includes('timeout')) return getMessage('analysisTimeout');
    if (text.includes('extract')) return getMessage('extractionFailed');
    return getMessage('analysisFailed');
}

// The error card's buttons for each kind of failure, in order. The service
// worker sends the kind with every failure (see ERROR_KINDS in background.js).
const ERROR_CARD_ACTIONS = {
    noKey: ['howToGetKey', 'openSettings'],
    keyRejected: ['openApiKeysPage', 'openSettings'],
    creditsDepleted: ['openApiKeysPage', 'openSettings'],
    busy: ['tryAgain'],
    rateLimited: ['tryAgain'],
    noModel: ['openApiKeysPage', 'openSettings'],
    pageUnreadable: ['reloadPage'],
    other: ['tryAgain'],
};
const AI_STUDIO_API_KEYS_URL = 'https://aistudio.google.com/apikey';

// What the error card says: what went wrong, why, the steps to fix it and its
// buttons. A kind the panel does not know is shown as 'other', which explains
// itself with the service worker's own message.
function errorCardContent(kind, message, getMessage) {
    const known = Object.prototype.hasOwnProperty.call(ERROR_CARD_ACTIONS, kind) ? kind : 'other';
    return {
        kind: known,
        title: getMessage(`errorTitle_${known}`),
        why: known === 'other' && message ? message : getMessage(`errorWhy_${known}`),
        intro: getMessage(known === 'creditsDepleted' ? 'errorIntroFree' : 'errorIntro'),
        steps: getMessage(`errorSteps_${known}`).split('\n').filter(Boolean),
        actions: ERROR_CARD_ACTIONS[known].map(action => ({ action, label: getMessage(`errorAction_${action}`) })),
    };
}

document.addEventListener('DOMContentLoaded', async function() {
    try {
        // Initialize our custom localization first
        await i18n.init();

        // Apply localization as soon as the DOM is loaded
        applyLocalization();

        const l = i18n.getMessage.bind(i18n);

        // Main view elements
        const settingsBtn = document.getElementById('settings-btn');
        const setupBtn = document.getElementById('setup-btn');
        const goToGCBtn = document.getElementById('go-to-gc-btn');
        const analyzeBtn = document.getElementById('analyze-btn');
        const welcomeScreen = document.getElementById('welcome-screen');
        const analysisView = document.getElementById('analysis-view');
        const statusIndicator = document.getElementById('status-indicator');
        const statusText = document.getElementById('status-text');
        const setupNotice = document.getElementById('setup-notice');
        const footerBar = document.querySelector('.footer-bar');
        const statusBar = document.querySelector('.status-bar');

        // Settings view elements
        const settingsView = document.getElementById('settings-view');
        const backBtn = document.getElementById('back-btn');
        const geminiApiKeyInput = document.getElementById('gemini-api-key');
        const toggleVisibilityBtn = document.getElementById('toggle-visibility');
        const verifyApiBtn = document.getElementById('test-api');
        const langJaRadio = document.getElementById('lang-ja');
        const langEnRadio = document.getElementById('lang-en');
        const autoCommentsCheckbox = document.getElementById('auto-comments-checkbox');
        const analysisCommentsRange = document.getElementById('analysis-comments-range');
        const analysisSliderValue = document.getElementById('analysis-slider-value');
        const displayCommentsRange = document.getElementById('display-comments-range');
        const displaySliderValue = document.getElementById('display-slider-value');
        const scrapeRepliesCheckbox = document.getElementById('scrape-replies-checkbox');
        const statusMessage = document.getElementById('status-message');
        const validationStatus = document.getElementById('validation-status');
        const manualCommentsGroup = document.getElementById('manual-comments-group');
        
        let currentAnalysis = null;
        let currentUrl = null;
        let extractionInProgress = false;
        let currentAnalysisId = null;
        let currentAnalysisTabId = null;
        let analysisPort = null;
        // Topic info for the open tab (includes the topic post's article links),
        // and article-site permissions declined while this panel is open.
        let topicInfoCache = null;
        const declinedArticleOrigins = new Set();
        const scopedAnalysisActions = new Set([
            'extractionProgress',
            'analysisProgress',
            'partialResults',
            'analysisComplete',
            'analysisFailed',
            'analysisCancelled'
        ]);
        
        // ALL FUNCTION DEFINITIONS SHOULD BE HERE, INSIDE THE HANDLER
        
        // Function to set localization strings
        function applyLocalization() {
            const l = i18n.getMessage.bind(i18n);

            // Localize elements with data-i18n attribute
            document.querySelectorAll('[data-i18n]').forEach(elem => {
                const key = elem.getAttribute('data-i18n');
                const localizedString = l(key);
                if (localizedString) {
                    elem.innerHTML = localizedString;
                }
            });

            // Localize title attributes
            document.querySelectorAll('[data-i18n-title]').forEach(elem => {
                const key = elem.getAttribute('data-i18n-title');
                const localizedString = l(key);
                if (localizedString) {
                    elem.setAttribute('title', localizedString);
                }
            });

            // Localize accessible names of icon-only buttons
            document.querySelectorAll('[data-i18n-aria-label]').forEach(elem => {
                const localizedString = l(elem.getAttribute('data-i18n-aria-label'));
                if (localizedString) elem.setAttribute('aria-label', localizedString);
            });

            // Localize placeholder attributes
            document.querySelectorAll('[data-i18n-placeholder]').forEach(elem => {
                const key = elem.getAttribute('data-i18n-placeholder');
                const localizedString = l(key);
                if (localizedString) {
                    elem.setAttribute('placeholder', localizedString);
                }
            });
        }

        // Initialize popup
        async function init() {
            hideErrorCard();
            try {
                const settings = await getSettings();
                
                // Get current tab first
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                currentUrl = tab.url;
                
                // Check if on GirlsChannel topic
                if (isGirlsChannelTopic(currentUrl)) {
                    showAnalysisView();
                    await refreshAndLoadTopicInfo();

                    // Show setup notice if no API key
                    if (!settings.geminiApiKey) {
                        showSetupNotice();
                    } else {
                        hideSetupNotice();
                    }
                    // After the status reset above, so its notice stays visible.
                    await showSavedAnalysis(currentUrl);
                } else {
                    showWelcomeScreen();
                    
                    // Show setup notice if no API key
                    if (!settings.geminiApiKey) {
                        showSetupNotice();
                    } else {
                        hideSetupNotice();
                    }
                }

                // Check if settings should be opened via context menu
                const result = await chrome.storage.local.get('openSettings');
                if (result.openSettings) {
                    openSettingsView();
                    await chrome.storage.local.remove('openSettings');
                }

                // Load settings into the settings view
                await loadSettingsForPanel();
                
            } catch (error) {
                console.error('Initialization error:', error);
                updateStatus('error', l('statusError'));
            }
        }
        
        // Get settings
        async function getSettings() {
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
                    // The key is kept on this device only; the service worker
                    // moves keys saved by older versions out of sync storage.
                    chrome.storage.local.get('geminiApiKey'),
                ]);

                return {
                    geminiApiKey: local.geminiApiKey || result.geminiApiKey || null,
                    language: result.language || 'ja',
                    commentsToAnalyze: result.commentsToAnalyze || 30,
                    commentsToDisplay: result.commentsToDisplay || 5,
                    autoCommentCalculation: result.autoCommentCalculation !== false,
                    scrapeReplies: result.scrapeReplies || false
                };
            } catch (error) {
                console.error('Error getting settings:', error);
                return {};
            }
        }
        
        // Check if on GirlsChannel topic
        function isGirlsChannelTopic(url) {
            return url && url.includes('girlschannel.net/topics/') && !url.includes('/search/');
        }
        
        // The error card replaces the status line while it is shown.
        const errorCard = document.getElementById('error-card');

        function showErrorCard(kind, message) {
            const card = errorCardContent(kind, message, l);
            updateStatus('error', card.title);
            if (!errorCard) return;
            errorCard.querySelector('.error-card-title').textContent = card.title;
            errorCard.querySelector('.error-card-why').textContent = card.why;
            errorCard.querySelector('.error-card-intro').textContent = card.intro;
            errorCard.querySelector('.error-card-steps').replaceChildren(...card.steps.map(text => {
                const item = document.createElement('li');
                item.textContent = text;
                return item;
            }));
            errorCard.querySelector('.error-card-actions').replaceChildren(...card.actions.map(({ action, label }) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'setup-btn';
                button.textContent = label;
                button.addEventListener('click', () => runErrorCardAction(action));
                return button;
            }));
            if (statusBar) statusBar.style.display = 'none';
            errorCard.classList.remove('hidden');
        }

        function hideErrorCard() {
            if (!errorCard || errorCard.classList.contains('hidden')) return;
            errorCard.classList.add('hidden');
            const inSettings = settingsView && settingsView.style.display === 'block';
            if (statusBar && !inSettings) statusBar.style.display = 'flex';
        }

        async function runErrorCardAction(action) {
            if (action === 'openApiKeysPage') {
                chrome.tabs.create({ url: AI_STUDIO_API_KEYS_URL });
            } else if (action === 'openSettings') {
                hideErrorCard();
                openSettingsView();
            } else if (action === 'howToGetKey') {
                const guide = document.getElementById('api-key-modal');
                if (guide) guide.classList.remove('hidden');
            } else if (action === 'tryAgain') {
                hideErrorCard();
                analyzeCurrentTopic();
            } else if (action === 'reloadPage') {
                hideErrorCard();
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab) chrome.tabs.reload(tab.id);
            }
        }

        // Show setup notice
        function showSetupNotice() {
            if (setupNotice) {
                setupNotice.style.display = 'block';
            }
            updateStatus('error', l('apiKeyRequired'));
        }
        
        // Hide setup notice
        function hideSetupNotice() {
            if (setupNotice) {
                setupNotice.style.display = 'none';
            }
            updateStatus('ready', l('statusReady'));
        }
        
        // Show welcome screen
        function showWelcomeScreen() {
            if (welcomeScreen) welcomeScreen.style.display = 'block';
            if (analysisView) analysisView.style.display = 'none';
            if (settingsView) settingsView.style.display = 'none';
            if (footerBar) footerBar.style.display = 'flex';
            if (statusBar) statusBar.style.display = 'flex';
            updateStatus('ready', l('statusReady'));
            
            // Hide React results if present
            const resultsRoot = document.getElementById('results-root');
            if (resultsRoot) resultsRoot.style.display = 'none';
        }
        
        // Show analysis view
        function showAnalysisView() {
            if (welcomeScreen) welcomeScreen.style.display = 'none';
            if (analysisView) analysisView.style.display = 'block';
            if (settingsView) settingsView.style.display = 'none';
            if (footerBar) footerBar.style.display = 'flex';
            if (statusBar) statusBar.style.display = 'flex';
            updateStatus('ready', l('statusReady'));
            
            // Hide React results initially
            const resultsRoot = document.getElementById('results-root');
            if (resultsRoot) resultsRoot.style.display = 'none';
            
            // Show analyze button
            if (analyzeBtn) analyzeBtn.style.display = 'inline-block';
        }

        // Open settings view
        function openSettingsView() {
            if (welcomeScreen) welcomeScreen.style.display = 'none';
            if (analysisView) analysisView.style.display = 'none';
            if (settingsView) settingsView.style.display = 'block';
            if (footerBar) footerBar.style.display = 'none';
            if (statusBar) statusBar.style.display = 'none';
            
            // Load current settings to ensure UI matches saved state
            loadSettingsForPanel();
        }

        // Close settings view
        async function closeSettingsView() {
            try {
                if (settingsView) settingsView.style.display = 'none';
                if (footerBar) footerBar.style.display = 'flex';
                if (statusBar) statusBar.style.display = 'flex';
                
                // Re-initialize to check API key and current page
                await init();
            } catch (error) {
                console.error('Error closing settings view:', error);
                // Fallback to welcome screen
                showWelcomeScreen();
            }
        }

        // Toggle API key visibility
        function toggleApiKeyVisibility() {
            if (geminiApiKeyInput) {
                if (geminiApiKeyInput.type === 'password') {
                    geminiApiKeyInput.type = 'text';
                    toggleVisibilityBtn.textContent = '🙈';
                } else {
                    geminiApiKeyInput.type = 'password';
                    toggleVisibilityBtn.textContent = '👁️';
                }
            }
        }

        // Update status
        function updateStatus(type, message) {
            if (statusIndicator) {
                const statusDot = statusIndicator.querySelector('.status-dot');
                if (statusDot) {
                    statusDot.className = `status-dot ${type}`;
                }
            }
            if (statusText) {
                statusText.textContent = message;
            }
        }

        // Save a specific setting
        async function saveSetting(key, value) {
            const l = i18n.getMessage.bind(i18n);
            displayStatus(l('savingSettings'), 'info');

            try {
                if (key === 'geminiApiKey') {
                    await chrome.storage.local.set({ geminiApiKey: value });
                    await chrome.storage.sync.remove('geminiApiKey');
                } else {
                    await chrome.storage.sync.set({ [key]: value });
                }

                // Notify background script about the update
                const settings = await getSettings();
                await chrome.runtime.sendMessage({
                    action: 'settingsUpdated',
                    settings: settings
                });

                if (key === 'language') {
                    // Force a reload to apply new language settings immediately
                    document.location.reload();
                }

                setTimeout(() => {
                    displayStatus(l('saveSuccess'), 'success');
                }, 500);

            } catch (error) {
                console.error('Error saving setting:', error);
                displayStatus(l('saveError'), 'error');
            }
        }

        // Display status message
        function displayStatus(message, type = 'info') {
            if (statusMessage) {
                statusMessage.textContent = message;
                statusMessage.className = `status-message ${type}`;
                statusMessage.style.display = 'block';

                setTimeout(() => {
                    statusMessage.style.display = 'none';
                }, 3000);
            }
        }

        // Toggle comments range slider
        function toggleCommentsRange(isAuto) {
            if (manualCommentsGroup) {
                manualCommentsGroup.style.display = isAuto ? 'none' : 'block';
            }
        }

        // Load settings from storage and update UI
        async function loadSettingsForPanel() {
            try {
                const result = await getSettings();

                if (geminiApiKeyInput) {
                    geminiApiKeyInput.value = result.geminiApiKey || '';
                }

                if (result.language === 'en') {
                    if (langEnRadio) langEnRadio.checked = true;
                } else {
                    if (langJaRadio) langJaRadio.checked = true;
                }

                const autoCalc = result.autoCommentCalculation;
                if (autoCommentsCheckbox) {
                    autoCommentsCheckbox.checked = autoCalc;
                }
                toggleCommentsRange(autoCalc);

                if (analysisCommentsRange) {
                    analysisCommentsRange.value = result.commentsToAnalyze;
                    if (analysisSliderValue) analysisSliderValue.textContent = analysisCommentsRange.value;
                }

                if (displayCommentsRange) {
                    displayCommentsRange.value = result.commentsToDisplay;
                    if (displaySliderValue) displaySliderValue.textContent = displayCommentsRange.value;
                }

                if (scrapeRepliesCheckbox) {
                    scrapeRepliesCheckbox.checked = result.scrapeReplies;
                }

                if (verifyApiBtn && geminiApiKeyInput) {
                    verifyApiBtn.disabled = (geminiApiKeyInput.value.trim() === '');
                }

            } catch (error) {
                console.error('Error loading settings:', error);
                displayStatus(l('loadError'), 'error');
            }
        }

        // Verify the API key
        async function verifyApiKey() {
            if (!geminiApiKeyInput) return;

            const apiKey = geminiApiKeyInput.value.trim();
            
            if (!apiKey) {
                if (validationStatus) {
                    validationStatus.textContent = l('apiKeyRequired');
                    validationStatus.className = 'validation-status error';
                }
                return;
            }

            if (verifyApiBtn) {
                verifyApiBtn.disabled = true;
            }
            if (validationStatus) {
                validationStatus.textContent = l('testing');
                validationStatus.className = 'validation-status loading';
            }

            try {
                // Add a small timeout to ensure background script is ready
                await new Promise(resolve => setTimeout(resolve, 100));
                
                let response;
                try {
                    response = await chrome.runtime.sendMessage({
                        action: 'validateApiKey',
                        apiKey: apiKey
                    });
                } catch (sendError) {
                    console.error('Error sending message:', sendError);
                    throw new Error('Failed to communicate with extension. Please reload the extension.');
                }

                if (!response) {
                    throw new Error('No response from extension. Please try again.');
                }

                if (response.success) {
                    if (validationStatus) {
                        validationStatus.textContent = l('apiKeyValid');
                        validationStatus.className = 'validation-status success';
                    }
                } else {
                    throw new Error(response.error || l('apiKeyInvalid'));
                }
            } catch (error) {
                if (validationStatus) {
                    // A key that works but cannot reach a usable model gets its own message.
                    validationStatus.textContent = error.message === l('modelUnavailable')
                        ? error.message
                        : `${l('apiKeyInvalid')}: ${error.message}`;
                    validationStatus.className = 'validation-status error';
                }
            } finally {
                if (verifyApiBtn) {
                    verifyApiBtn.disabled = false;
                }
            }
        }

        // Load topic information from storage
        async function loadTopicInfo() {
            try {
                updateStatus('loading', l('statusLoading'));
                
                const { currentTopicInfo } = await chrome.storage.local.get('currentTopicInfo');
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                const settings = await getSettings();
                
                topicInfoCache = currentTopicInfo && currentTopicInfo.url === tab.url ? currentTopicInfo : null;
                if (topicInfoCache) {
                    const { title, commentCount, url, postDate } = currentTopicInfo;
                    
                    if (document.getElementById('topic-title')) document.getElementById('topic-title').textContent = title;
                    if (document.getElementById('topic-url')) document.getElementById('topic-url').textContent = url;
                    if (document.getElementById('comment-count')) document.getElementById('comment-count').textContent = `${commentCount} ${l('commentsUnit') || 'comments'}`;
                    if (document.getElementById('analysis-date')) document.getElementById('analysis-date').textContent = postDate || '';
                    
                    updateStatus('ready', l('statusReady'));
                    // Enable analyze button only if API key exists
                    if (analyzeBtn) analyzeBtn.disabled = !settings.geminiApiKey;
                } else {
                    // Info is not available or for a different URL
                    if (document.getElementById('topic-title')) document.getElementById('topic-title').textContent = l('topicTitleFallback') || 'GirlsChannel Topic';
                    if (document.getElementById('topic-url')) document.getElementById('topic-url').textContent = tab.url;
                    if (document.getElementById('comment-count')) document.getElementById('comment-count').textContent = '';
                    if (document.getElementById('analysis-date')) document.getElementById('analysis-date').textContent = ''; // No date if no topic info
                    updateStatus('ready', `${l('statusReady')} (${l('infoLoadFailed') || 'Info load failed'})`);
                    if (analyzeBtn) analyzeBtn.disabled = true; // Disable analysis if info isn't loaded
                }
                
            } catch (error) {
                console.error('Error loading topic info from storage:', error);
                updateStatus('error', l('statusError'));
            }
        }

        async function waitForContentScript(tabId) {
            // Add a small initial delay to give the content script time to load
            await new Promise(resolve => setTimeout(resolve, 100));
            
            let retries = 10; // Increased from 5 to 10
            while (retries > 0) {
                try {
                    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
                    if (response && response.ready) {
                        return;
                    }
                } catch (e) {
                    // Ignore errors, we'll just retry
                }
                await new Promise(resolve => setTimeout(resolve, 500));
                retries--;
            }
            throw new Error('Content script not ready');
        }
        
        // Refresh and load topic info
        async function refreshAndLoadTopicInfo() {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab && isGirlsChannelTopic(tab.url)) {
                    // Wait for content script to be ready before sending a message
                    await waitForContentScript(tab.id);
                    // First, tell content script to re-scrape
                    await chrome.tabs.sendMessage(tab.id, { action: 'refreshTopicInfo' });
                    // Now, load the fresh data from storage
                    await loadTopicInfo();
                }
            } catch (error) {
                console.error('Error refreshing and loading topic info:', error);
                // Fallback to just loading whatever might be in storage
                await loadTopicInfo();
            }
        }

        // Mount the React results view once.
        function mountResults() {
            if (window.reactResultsMounted) return;
            ReactDOM.render(
                React.createElement(AnalysisResults, { i18n: i18n.getMessage.bind(i18n) }),
                document.getElementById('results-root')
            );
            window.reactResultsMounted = true;
        }

        // The results view exposes window.setAnalysisResults from an effect,
        // which runs just after mounting; wait for it (up to about a second).
        async function whenResultsReady() {
            for (let i = 0; i < 60 && !window.setAnalysisResults; i++) {
                await new Promise(resolve => setTimeout(resolve, 16));
            }
            return Boolean(window.setAnalysisResults);
        }

        // Show the saved analysis for this topic, if there is one. It stays
        // until the user runs a new analysis.
        async function showSavedAnalysis(tabUrl) {
            const pageInfo = globalThis.GirlsinSightParsing.topicPageInfo(tabUrl);
            if (!pageInfo || extractionInProgress) return;
            const { savedAnalyses = [] } = await chrome.storage.local.get('savedAnalyses');
            const saved = savedAnalyses.find(entry => entry.url === pageInfo.firstPageUrl);
            if (!saved) return;

            mountResults();
            if (!(await whenResultsReady())) return;
            window.setAnalysisResults(saved.analysis);
            currentAnalysis = saved.analysis;
            const resultsRoot = document.getElementById('results-root');
            if (resultsRoot) resultsRoot.style.display = 'block';
            if (document.body) document.body.classList.add('analysis-results-view');
            updateStatus('ready', l('savedAnalysisNotice', [new Date(saved.savedAt).toLocaleString()]));
        }

        // Analyze current topic
        async function analyzeCurrentTopic() {
            if (extractionInProgress) {
                if (confirm(l('stopConfirmation'))) {
                    await abortExtraction();
                }
                return;
            }
            
            let analysisResponse = null;
            try {
                // Ask for access only to the sites the topic post links to, plus
                // the Wayback Machine for dead links. This runs first, while
                // Chrome still treats the click as a user gesture. A decline is
                // remembered while the panel is open and is not fatal: the topic
                // post can still be summarized without the article.
                const origins = globalThis.GirlsinSightArticlePipeline.articleAccessOrigins(
                    topicInfoCache && topicInfoCache.articleUrls
                );
                const alreadyDeclined = origins.length > 0 && origins.every(origin => declinedArticleOrigins.has(origin));
                const articleAccessPromise = !origins.length || alreadyDeclined
                    ? Promise.resolve(false)
                    : chrome.permissions.request({ origins }).then(granted => {
                        origins.forEach(origin => (granted
                            ? declinedArticleOrigins.delete(origin)
                            : declinedArticleOrigins.add(origin)));
                        return granted;
                    }).catch(error => {
                        console.warn('Article site access was not granted:', error);
                        return false;
                    });
                const settings = await getSettings();
                const articleAccessGranted = await articleAccessPromise;
                
                if (!settings.geminiApiKey) {
                    showErrorCard('noKey');
                    return;
                }
                hideErrorCard();
                
                // Start analysis
                extractionInProgress = true;
                updateStatus('loading', l('statusExtracting'));
                updateAnalyzeButton(true);
                if (document.body) document.body.classList.add('analysis-results-view');

                // Mount React component immediately to show loading states
                const resultsRoot = document.getElementById('results-root');
                mountResults();

                // Clear previous results when starting new analysis
                if (window.clearAnalysisResults) {
                    window.clearAnalysisResults();
                }
                if (resultsRoot) resultsRoot.style.display = 'block';
                
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                currentAnalysisId = crypto.randomUUID();
                currentAnalysisTabId = tab.id;
                window.currentAnalysisId = currentAnalysisId;
                // Kept open for the run; Chrome closes it with the panel, which
                // tells the service worker to cancel.
                analysisPort = chrome.runtime.connect({ name: `analysis:${currentAnalysisId}` });
                
                // Delegate the entire analysis process to the background script
                analysisResponse = await chrome.runtime.sendMessage({
                    action: 'startFullAnalysis',
                    data: {
                        analysisId: currentAnalysisId,
                        tabId: tab.id,
                        tabUrl: tab.url,
                        settings: settings,
                        articleAccessGranted,
                    }
                });

                if (analysisResponse?.cancelled) return;
                if (!analysisResponse || !analysisResponse.success) {
                    throw new Error(analysisResponse?.error || 'Analysis initiation failed');
                }

                // The rest of the updates will be handled by progressive messages.
                // We just need to know when it's all done.
                
            } catch (error) {
                console.error('Analysis error:', error);
                extractionInProgress = false;
                currentAnalysisId = null;
                currentAnalysisTabId = null;
                window.currentAnalysisId = null;
                updateAnalyzeButton(false);
                
                // Hide React component on error
                const resultsRoot = document.getElementById('results-root');
                if (resultsRoot) {
                    resultsRoot.style.display = 'none';
                }
                if (analyzeBtn) analyzeBtn.style.display = 'inline-block'; // Show analyze button again
                
                const errorKind = (analysisResponse && analysisResponse.errorKind) ||
                    (/establish connection|receiving end/i.test(String(error.message)) ? 'pageUnreadable' : 'other');
                showErrorCard(errorKind, analysisErrorMessage(error, analysisResponse, l));
                if (document.body) document.body.classList.remove('analysis-results-view');
            }
        }
        
        // Abort extraction
        async function abortExtraction() {
            try {
                extractionInProgress = false;
                await chrome.runtime.sendMessage({
                    action: 'abortAnalysis',
                    data: {
                        analysisId: currentAnalysisId,
                        tabId: currentAnalysisTabId,
                    }
                });
                updateAnalyzeButton(false);
                updateStatus('ready', l('analysisStopped'));
                currentAnalysisId = null;
                currentAnalysisTabId = null;
                window.currentAnalysisId = null;
            } catch (error) {
                console.error('Error aborting:', error);
            }
        }
        
        // Update analyze button
        function updateAnalyzeButton(isExtracting) {
            if (!analyzeBtn) return;
            const btnText = analyzeBtn.querySelector('.btn-text');
            
            if (isExtracting) {
                btnText.textContent = l('stopButton');
                analyzeBtn.style.background = '#e53e3e';
            } else {
                btnText.textContent = l('analyzeButton');
                analyzeBtn.style.background = '';
            }
        }
        
        // Download Excel
        async function downloadExcel() {
            try {
                if (!currentAnalysis) {
                    throw new Error(l('noAnalysisData'));
                }
                
                updateStatus('loading', l('statusGenerating'));
                
                const result = await chrome.runtime.sendMessage({
                    action: 'generateExcel',
                    data: {
                        analysis: currentAnalysis,
                        url: currentUrl
                    }
                });
                
                if (result && result.success) {
                    updateStatus('ready', l('fileDownloaded'));
                } else {
                    throw new Error(result?.error || l('downloadFailed'));
                }
                
            } catch (error) {
                console.error('Download error:', error);
                updateStatus('error', l('downloadFailed'));
            }
        }

        // Event listeners
        if (settingsBtn) settingsBtn.addEventListener('click', openSettingsView);
        if (backBtn) backBtn.addEventListener('click', closeSettingsView);
        if (setupBtn) setupBtn.addEventListener('click', openSettingsView);
        if (goToGCBtn) goToGCBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: globalThis.GirlsinSightParsing.GIRLSCHANNEL_HOME_URL });
        });
        if (analyzeBtn) analyzeBtn.addEventListener('click', analyzeCurrentTopic);
        
        // Download button event listener - use event delegation since it's rendered by React
        document.addEventListener('click', (e) => {
            if (e.target && e.target.id === 'download-btn') {
                downloadExcel();
            }
        });
        
        // Tab switching - removed as it's handled by React now
        
        // Settings event listeners
        if (geminiApiKeyInput) {
            geminiApiKeyInput.addEventListener('input', () => {
                saveSetting('geminiApiKey', geminiApiKeyInput.value);
                if (verifyApiBtn) {
                    verifyApiBtn.disabled = geminiApiKeyInput.value.trim() === '';
                }
                if (validationStatus) {
                    validationStatus.textContent = '';
                    validationStatus.className = 'validation-status';
                }
            });
        }
        
        if (toggleVisibilityBtn) toggleVisibilityBtn.addEventListener('click', toggleApiKeyVisibility);
        if (verifyApiBtn) verifyApiBtn.addEventListener('click', verifyApiKey);

        if (langJaRadio) langJaRadio.addEventListener('change', () => saveSetting('language', 'ja'));
        if (langEnRadio) langEnRadio.addEventListener('change', () => saveSetting('language', 'en'));

        if (autoCommentsCheckbox) {
            autoCommentsCheckbox.addEventListener('change', () => {
                const isAuto = autoCommentsCheckbox.checked;
                saveSetting('autoCommentCalculation', isAuto);
                toggleCommentsRange(isAuto);
            });
        }

        if (analysisCommentsRange) {
            analysisCommentsRange.addEventListener('input', () => {
                if (analysisSliderValue) analysisSliderValue.textContent = analysisCommentsRange.value;
            });
            analysisCommentsRange.addEventListener('change', () => {
                saveSetting('commentsToAnalyze', parseInt(analysisCommentsRange.value, 10));
            });
        }

        if (displayCommentsRange) {
            displayCommentsRange.addEventListener('input', () => {
                if (displaySliderValue) displaySliderValue.textContent = displayCommentsRange.value;
            });
            displayCommentsRange.addEventListener('change', () => {
                saveSetting('commentsToDisplay', parseInt(displayCommentsRange.value, 10));
            });
        }

        if (scrapeRepliesCheckbox) {
            scrapeRepliesCheckbox.addEventListener('change', () => {
                saveSetting('scrapeReplies', scrapeRepliesCheckbox.checked);
            });
        }
        
        // Listen for messages
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (scopedAnalysisActions.has(message.action) && message.analysisId &&
                message.analysisId !== currentAnalysisId) {
                return;
            }
            if (message.action === 'extractionProgress') {
                const l = i18n.getMessage.bind(i18n);
                const data = message.data;
                let progressMessage = '';
                
                // Only show progress for the main comments extraction
                if (data.type === 'comments') {
                    progressMessage = l('progressExtractingComments') + ` (${data.processed}/${data.total})`;
                } else if (data.type === 'message') {
                    // Still allow generic progress messages
                    progressMessage = data.text;
                }
                
                if (progressMessage) {
                    updateStatus('loading', progressMessage);
                }
            } else if (message.action === 'analysisProgress') {
                // Handle analysis progress messages from background script
                if (message.message) {
                    updateStatus('loading', message.message);
                }
            } else if (message.action === 'analysisComplete') {
                extractionInProgress = false;
                updateAnalyzeButton(false);
                updateStatus('ready', l('statusComplete'));
                // The summary and stats stay; a failed sentiment part gets a card above them.
                const sentiment = message.data && message.data.sentiment;
                if (sentiment && sentiment.errorKind) showErrorCard(sentiment.errorKind, sentiment.details);
                // Store final results for download
                if (message.data) {
                    currentAnalysis = message.data;
                }
                // NEW: Signal to the React component that it's safe to show the download button
                if (window.markAnalysisAsComplete) {
                    window.markAnalysisAsComplete();
                }
                currentAnalysisId = null;
                currentAnalysisTabId = null;
                window.currentAnalysisId = null;
            } else if (message.action === 'analysisFailed') {
                extractionInProgress = false;
                updateAnalyzeButton(false);
                showErrorCard(message.errorKind, message.error);
                
                const resultsRoot = document.getElementById('results-root');
                if (resultsRoot) resultsRoot.style.display = 'none';
                if (analyzeBtn) analyzeBtn.style.display = 'inline-block';
                if (document.body) document.body.classList.remove('analysis-results-view');
                currentAnalysisId = null;
                currentAnalysisTabId = null;
                window.currentAnalysisId = null;
            } else if (message.action === 'analysisCancelled') {
                extractionInProgress = false;
                updateAnalyzeButton(false);
                updateStatus('ready', l('analysisStopped'));
                currentAnalysisId = null;
                currentAnalysisTabId = null;
                window.currentAnalysisId = null;
            } else if (message.action === 'urlChanged') {
                // URL changed, refresh the content if we're on a topic page
                if (message.url && message.url.includes('/topics/')) {
                    // Reset the current analysis
                    currentAnalysis = null;
                    currentUrl = message.url;
                    
                    // Hide any existing results
                    const resultsRoot = document.getElementById('results-root');
                    if (resultsRoot) resultsRoot.style.display = 'none';
                    if (document.body) document.body.classList.remove('analysis-results-view');
                    
                    // Clear previous results data
                    if (window.clearAnalysisResults) {
                        window.clearAnalysisResults();
                    }
                    
                    // Re-initialize to load the new topic
                    init();
                }
            } else if (message.action === 'showWelcomeScreen') {
                // User navigated away from a topic page
                // Reset the current analysis
                currentAnalysis = null;
                currentUrl = null;
                
                // Hide any existing results
                const resultsRoot = document.getElementById('results-root');
                if (resultsRoot) resultsRoot.style.display = 'none';
                if (document.body) document.body.classList.remove('analysis-results-view');
                
                // Clear previous results data
                if (window.clearAnalysisResults) {
                    window.clearAnalysisResults();
                }
                
                // Show the welcome screen
                showWelcomeScreen();
            }
        });
        
        // Setup modal
        const apiKeyLink = document.getElementById('api-key-help');
        const modal = document.getElementById('api-key-modal');
        const closeButton = document.getElementById('modal-close-button');

        if (apiKeyLink && modal && closeButton) {
            apiKeyLink.addEventListener('click', (e) => {
                e.preventDefault();
                modal.classList.remove('hidden');
            });

            closeButton.addEventListener('click', () => {
                modal.classList.add('hidden');
            });

            // Close modal if user clicks outside of the content
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.classList.add('hidden');
                }
            });
        }

        // Initialize popup
        init();
        
    } catch (error) {
        console.error('DOMContentLoaded error:', error);
        // Can't use updateStatus here since it might not be initialized
        // Just log the error
    }
});
