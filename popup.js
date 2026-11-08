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
                const result = await chrome.storage.sync.get([
                    'geminiApiKey',
                    'language',
                    'commentsToAnalyze',
                    'commentsToDisplay',
                    'autoCommentCalculation',
                    'scrapeReplies'
                ]);
                
                return {
                    geminiApiKey: result.geminiApiKey || null,
                    language: result.language || 'ja',
                    commentsToAnalyze: result.commentsToAnalyze || 100,
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
                await chrome.storage.sync.set({ [key]: value });

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
                    validationStatus.textContent = `${l('apiKeyInvalid')}: ${error.message}`;
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
                
                if (currentTopicInfo && currentTopicInfo.url === tab.url) {
                    const { title, commentCount, url, postDate } = currentTopicInfo;
                    
                    if (document.getElementById('topic-title')) document.getElementById('topic-title').textContent = title;
                    if (document.getElementById('topic-url')) document.getElementById('topic-url').textContent = url;
                    if (document.getElementById('comment-count')) document.getElementById('comment-count').textContent = `${commentCount} ${l('commentsUnit') || 'comments'}`;
                    if (document.getElementById('analysis-date')) document.getElementById('analysis-date').textContent = postDate || new Date().toLocaleDateString();
                    
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

        // Analyze current topic
        async function analyzeCurrentTopic() {
            if (extractionInProgress) {
                if (confirm(l('stopConfirmation'))) {
                    await abortExtraction();
                }
                return;
            }
            
            try {
                // Chrome shows its own permission prompt on the explicit Analyze click.
                // Denial is non-fatal: the first comment can still be summarized.
                const articleAccessPromise = chrome.permissions.request({
                    origins: ['http://*/*', 'https://*/*']
                }).catch(error => {
                    console.warn('Article host access was not granted:', error);
                    return false;
                });
                const settings = await getSettings();
                const articleAccessGranted = await articleAccessPromise;
                
                if (!settings.geminiApiKey) {
                    showSetupNotice();
                    return;
                }
                
                // Start analysis
                extractionInProgress = true;
                updateStatus('loading', l('statusExtracting'));
                updateAnalyzeButton(true);
                if (document.body) document.body.classList.add('analysis-results-view');

                // Mount React component immediately to show loading states
                const resultsRoot = document.getElementById('results-root');
                if (!window.reactResultsMounted) {
                    ReactDOM.render(
                        React.createElement(AnalysisResults, { 
                            i18n: i18n.getMessage.bind(i18n) 
                        }), 
                        resultsRoot
                    );
                    window.reactResultsMounted = true;
                }
                
                // Clear previous results when starting new analysis
                if (window.clearAnalysisResults) {
                    window.clearAnalysisResults();
                }
                if (resultsRoot) resultsRoot.style.display = 'block';
                
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                currentAnalysisId = crypto.randomUUID();
                currentAnalysisTabId = tab.id;
                window.currentAnalysisId = currentAnalysisId;
                
                // Delegate the entire analysis process to the background script
                const analysisResponse = await chrome.runtime.sendMessage({
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
                
                let errorMessage = l('analysisFailed');
                if (error.message.includes('timeout')) {
                    errorMessage = l('analysisTimeout');
                } else if (error.message.includes('extract')) {
                    errorMessage = l('extractionFailed');
                } else if (error.message.includes('API')) {
                    errorMessage = l('apiKeyError');
                }
                
                updateStatus('error', errorMessage);
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
            chrome.tabs.create({ url: 'https://www.girlschannel.net/' });
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
                updateStatus('error', message.error || l('analysisFailed'));
                
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
