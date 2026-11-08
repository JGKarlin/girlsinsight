// Content script for GirlsChannel pages - With sub-comment extraction
(function() {
    'use strict';
    // Loaded first by the manifest's content_scripts list.
    const { compareCommentNumbers, parseGirlsChannelDate, topicPageInfo } = globalThis.GirlsinSightParsing;
    const DEBUG = false; // true logs routine activity to the page console
    const debugLog = (...args) => { if (DEBUG) console.log(...args); };
    let activeAnalysisId = null;
    const cancelledAnalysisIds = new Set();
    
    // Listen for messages from popup for manual extraction
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        switch (request.action) {
            case 'startPhasedExtraction':
                startPhasedExtraction(request.options, request.analysisId);
                sendResponse({ success: true, message: 'Phased extraction initiated.' });
                return false; // No need to keep the channel open
            case 'abortExtraction':
                cancelledAnalysisIds.add(request.analysisId || activeAnalysisId);
                sendResponse({ success: true, cancelled: true });
                return false;
            case 'refreshTopicInfo':
                scrapeAndStoreTopicInfo({ fetchFirstPage: true }).then(() => sendResponse({ success: true }));
                return true;
            case 'ping':
                sendResponse({ ready: true });
                return true;
        }
    });

    // --- Main Logic ---
    // Check if we are on a topic page and scrape info automatically
    if (topicPageInfo(window.location.href)) {
        scrapeAndStoreTopicInfo();
    }
    
    // Debug function to test reply detection (can be called from console)
    window.testReplyDetection = function() {
        console.log('=== Testing Reply Detection ===');
        const commentElements = document.querySelectorAll('.comment-item');
        console.log(`Found ${commentElements.length} comments on page`);
        
        let commentsWithReplies = 0;
        commentElements.forEach((element, index) => {
            if (index >= 10) return; // Only check first 10 comments
            
            const numberElement = element.querySelector('.info');
            const number = numberElement ? parseInt(numberElement.textContent.split('.')[0], 10) : index + 1;
            
            // Check for comment-url-title div (same as actual implementation)
            const commentUrlTitleDiv = element.querySelector('.comment-url-title');
            if (commentUrlTitleDiv) {
                const replyUrls = Array.from(commentUrlTitleDiv.querySelectorAll('a[href]'))
                    .map(a => a.href)
                    .filter(url => url.includes('/res/'));
                
                if (replyUrls.length > 0) {
                    console.log(`Comment #${number}: Found ${replyUrls.length} reply URL(s):`);
                    replyUrls.forEach(url => console.log(`  - ${url}`));
                    commentsWithReplies++;
                } else {
                    const allUrls = Array.from(commentUrlTitleDiv.querySelectorAll('a[href]')).map(a => a.href);
                    if (allUrls.length > 0) {
                        console.log(`Comment #${number}: Found ${allUrls.length} non-reply URL(s)`);
                    }
                }
            } else if (index < 3) {
                console.log(`Comment #${number}: No comment-url-title div found`);
            }
        });
        
        console.log(`\nTotal comments with reply URLs: ${commentsWithReplies}`);
        console.log('Note: Sub-comments will be numbered as XXXX.001, XXXX.002, etc.');
        console.log('=== End Reply Detection Test ===');
    };
    
    // --- In-depth Debugging Function ---
    window.debugPageStructure = function() {
        console.log("--- Starting Page Structure Debug ---");
        const comments = document.querySelectorAll('.comment-item');
        console.log(`Found ${comments.length} comment elements.`);

        if (comments.length === 0) {
            console.log("No comments found on this page. Aborting debug.");
            return;
        }

        console.log("\n--- Analyzing first 5 comments for reply indicators ---");
        for (let i = 0; i < Math.min(comments.length, 5); i++) {
            const comment = comments[i];
            const numberEl = comment.querySelector('.info');
            const number = numberEl ? numberEl.textContent.trim().split('.')[0] : `(unknown #${i + 1})`;

            console.log(`\n[Comment #${number}]`);
            
            // 1. Check for '.comment-url-title' div (Python script's method)
            const urlTitleDiv = comment.querySelector('.comment-url-title');
            if (urlTitleDiv) {
                console.log("  ✅ Found a '.comment-url-title' div.");
                const links = urlTitleDiv.querySelectorAll('a');
                if (links.length > 0) {
                    console.log(`    - Contains ${links.length} link(s). First one is:`, links[0].outerHTML);
                } else {
                    console.log("    - But it contains no links.");
                }
            } else {
                console.log("  ❌ No '.comment-url-title' div found.");
            }

            // 2. Check for any link containing '/res/'
            const resLinks = comment.querySelectorAll('a[href*="/res/"]');
            if (resLinks.length > 0) {
                console.log(`  ✅ Found ${resLinks.length} link(s) containing '/res/'.`);
                console.log(`    - First one is:`, resLinks[0].outerHTML);
            } else {
                console.log("  ❌ No links containing '/res/' found.");
            }
            
            // 3. Check for any link containing the text '件の返信'
            const replyTextLinks = Array.from(comment.querySelectorAll('a')).filter(a => a.textContent.includes('件の返信'));
            if (replyTextLinks.length > 0) {
                console.log(`  ✅ Found ${replyTextLinks.length} link(s) with text '件の返信'.`);
                console.log(`    - First one is:`, replyTextLinks[0].outerHTML);
            } else {
                console.log("  ❌ No links with text '件の返信' found.");
            }
        }
        console.log("\n--- Debug Finished ---");
        console.log("Please copy the text from '--- Starting Page Structure Debug ---' to '--- Debug Finished ---' and paste it back to the assistant.");
    };
    
    // Get topic post date from the first comment of a topic's first page
    function getTopicDate(doc = document) {
        // The first comment is the actual topic post
        const firstComment = doc.querySelector('.comment-item');
        if (firstComment) {
            const dateElement = firstComment.querySelector('a[rel="nofollow"]');
            if (dateElement) {
                // Remove day of week in parentheses and trim
                const dateText = dateElement.textContent.replace(/\(.*?\)/g, '').trim();
                return dateText;
            }
        }
        return null;
    }
    
    // Scrape topic info and store it in local storage. Only page 1 starts with
    // the topic post (its date and article links). On later pages that page is
    // fetched only when the side panel asks (fetchFirstPage), so simply reading
    // a page never makes extra requests.
    async function scrapeAndStoreTopicInfo({ fetchFirstPage = false } = {}) {
        try {
            const title = getTopicTitle();
            const commentCount = getCommentCount();
            const url = window.location.href;
            const pageInfo = topicPageInfo(url);
            let firstPageDoc = pageInfo && pageInfo.page === 1 ? document : null;
            if (!firstPageDoc && pageInfo && fetchFirstPage) {
                try {
                    const html = await fetchPage(pageInfo.firstPageUrl);
                    firstPageDoc = new DOMParser().parseFromString(html, 'text/html');
                } catch (error) {
                    console.warn('GirlsinSight: could not read the topic\'s first page:', error);
                }
            }
            const topicPost = firstPageDoc && firstPageDoc.querySelector('.comment-item');

            const topicInfo = {
                title,
                commentCount,
                url,
                postDate: firstPageDoc ? getTopicDate(firstPageDoc) : null,
                // Links in the topic post; the panel asks for access to these sites.
                articleUrls: topicPost ? extractCommentData(topicPost).urls : null,
                timestamp: new Date().getTime()
            };

            await chrome.storage.local.set({ currentTopicInfo: topicInfo });
            debugLog('GirlsinSight: Topic info scraped and stored.', topicInfo);

            // Ask the background script for the translated message
            chrome.runtime.sendMessage({
                action: 'getLocalizedString',
                key: 'progressTopicDetected'
            }, (translatedString) => {
                if (translatedString) {
                    sendProgress(translatedString);
                }
            });

        } catch (error) {
            console.error('GirlsinSight: Error scraping topic info:', error);
            // Clear old data on failure
            await chrome.storage.local.remove('currentTopicInfo');
        }
    }
    
    // Get topic title
    function getTopicTitle() {
        // Try the most common selectors first
        const h1 = document.querySelector('h1');
        if (h1 && h1.textContent.trim()) {
            return h1.textContent.trim();
        }
        
        // Fallback to page title
        const pageTitle = document.title;
        if (pageTitle && !pageTitle.includes('ガールズちゃんねる')) {
            return pageTitle.trim();
        }
        
        return 'Title not found';
    }
    
    // Get comment count
    function getCommentCount() {
        // Try to find comment count indicator
        const commentSpan = document.querySelector('.icon-comment');
        if (commentSpan && commentSpan.nextElementSibling) {
            const text = commentSpan.nextElementSibling.textContent;
            const match = text.match(/(\d+)/);
            if (match) {
                return parseInt(match[1], 10);
            }
        }
        
        // Fallback: count actual comments
        const comments = document.querySelectorAll('.comment-item');
        return comments.length > 0 ? comments.length : 'N/A';
    }
    
    // --- Manual Extraction Logic ---
    async function startPhasedExtraction(options = {}, analysisId = null) {
        activeAnalysisId = analysisId;
        cancelledAnalysisIds.delete(analysisId);
        try {
            // Analysis always starts from the topic's first page, which holds
            // the topic post, even when the user is reading a later page.
            const pageInfo = topicPageInfo(window.location.href);
            let firstPageDoc = document;
            if (pageInfo && pageInfo.page > 1) {
                const html = await fetchPage(pageInfo.firstPageUrl, analysisId);
                firstPageDoc = new DOMParser().parseFromString(html, 'text/html');
            }

            // --- Phase 1: Immediately extract and send initial data ---
            const topicData = {
                title: getTopicTitle(),
                url: pageInfo ? pageInfo.firstPageUrl : window.location.href,
                postDate: getTopicDate(firstPageDoc)
            };

            const firstCommentData = [];
            const firstCommentElement = firstPageDoc.querySelector('.comment-item');
            if (firstCommentElement) {
                const comment = extractCommentData(firstCommentElement);
                if (comment && comment.text) {
                    firstCommentData.push(comment);
                }
            }
            
            chrome.runtime.sendMessage({
                action: 'initialDataReady',
                analysisId,
                data: {
                    success: true,
                    data: {
                        topicData,
                        firstPageComments: firstCommentData
                    }
                }
            });

            // --- Phase 2: Extract all comments and send when complete ---
            // Pass total comment count for progress reporting
            const totalComments = getCommentCount();
            const comments = await extractCommentsFromAllPages(
                options.scrapeReplies,
                totalComments,
                analysisId,
                firstPageDoc
            );

            if (isAnalysisCancelled(analysisId)) {
                throw new Error('Extraction aborted by user');
            }

            // --- Phase 3: Calculate final statistics ---
            const activityStats = calculateActivityScore(comments);

            // The service worker takes over the status line from here: it shows
            // which Gemini step is still running.
            chrome.runtime.sendMessage({
                action: 'allCommentsReady',
                analysisId,
                data: { success: true, data: { comments: comments, activityStats: activityStats } }
            });

        } catch (error) {
            console.error('GirlsinSight: Phased extraction error:', error);
            chrome.runtime.sendMessage({
                action: 'allCommentsReady', // Send on this channel to unblock the background script
                analysisId,
                data: { success: false, error: error.message }
            });
        } finally {
            if (activeAnalysisId === analysisId) activeAnalysisId = null;
            cancelledAnalysisIds.delete(analysisId);
        }
    }
    
    // Extract comments from all pages using concurrent reply fetching
    async function extractCommentsFromAllPages(scrapeReplies = false, totalMainComments = 'N/A', analysisId = null, startDoc = document) {
        const allComments = [];
        const replyUrlMap = new Map(); // To store parentNumber for each reply URL

        // --- Step 1: Sequentially scrape main pages and gather all main comments and reply URLs ---
        let doc = startDoc;
        let currentPage = 1;

        while (true) {
            if (isAnalysisCancelled(analysisId)) return [];

            // Send structured progress update
            sendProgress({
                type: 'comments',
                processed: allComments.length,
                total: totalMainComments
            }, analysisId);

            const commentElements = doc.querySelectorAll('.comment-item');
            if (commentElements.length === 0) break;

            for (const element of commentElements) {
                const comment = extractCommentData(element);
                if (comment && comment.text) {
                    allComments.push(comment);
                    const replyLinks = findReplyLinks(element);
                    if (replyLinks.length > 0) {
                        replyLinks.forEach(link => {
                            if (!replyUrlMap.has(link)) {
                                replyUrlMap.set(link, comment.number);
                            }
                        });
                    }
                }
            }

            const nextPageUrl = getNextPageUrlFromDocument(doc);
            if (!nextPageUrl) break;
            
            currentPage++;
            try {
                await sleep(200);
                const html = await fetchPage(nextPageUrl, analysisId);
                doc = new DOMParser().parseFromString(html, 'text/html');
            } catch (error) {
                console.error('Error fetching next page:', error);
                break;
            }
        }
        
        // --- Step 2: Concurrently fetch all unique reply pages in batches (CONDITIONAL) ---
        const allReplies = [];
        if (scrapeReplies && replyUrlMap.size > 0) {
            // The sentiment essay reads main comments only: send them now so
            // it can start while the reply pages are read.
            chrome.runtime.sendMessage({
                action: 'mainCommentsReady',
                analysisId,
                data: { success: true, data: { comments: allComments.slice() } }
            });

            const urlsToFetch = Array.from(replyUrlMap.keys());
            const batchSize = 5; // Set a small batch size to avoid being blocked

            for (let i = 0; i < urlsToFetch.length; i += batchSize) {
                if (isAnalysisCancelled(analysisId)) return [];
                const batchUrls = urlsToFetch.slice(i, i + batchSize);
                
                // Send reply progress update
                sendProgress({
                    type: 'replies',
                    processed: Math.min(i + batchSize, urlsToFetch.length),
                    total: urlsToFetch.length
                }, analysisId);

                const batchPromises = batchUrls.map(url =>
                    fetchPage(url, analysisId)
                    .then(html => ({ html, url }))
                    .catch(error => {
                        console.error(`Failed to fetch reply page: ${url}`, error);
                        return null;
                    })
                );

                const htmlResults = await Promise.all(batchPromises);
                
                htmlResults.filter(r => r !== null).forEach(result => {
                    const parentNumber = replyUrlMap.get(result.url);
                    const replies = extractRepliesFromHtml(result.html, parentNumber);
                    allReplies.push(...replies);
                });

                if (i + batchSize < urlsToFetch.length) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
        }

        // --- Step 3: Combine, de-duplicate, and sort all comments ---
        const finalComments = allComments.concat(allReplies);
        const uniqueComments = Array.from(new Map(finalComments.map(c => [c.number, c])).values());
        
        uniqueComments.sort((a, b) => compareCommentNumbers(a.number, b.number));

        return uniqueComments;
    }

    // Finds reply links within a single comment element
    function findReplyLinks(commentElement) {
        const replyLinks = new Set();
        const base = "https://girlschannel.net";
        commentElement.querySelectorAll('a[href]').forEach(link => {
            if (link.textContent && link.textContent.includes('件の返信')) {
                const href = link.getAttribute('href');
                if(href) replyLinks.add(new URL(href, base).href);
            }
        });
        return Array.from(replyLinks);
    }
    
    // Helper function to extract replies from a fetched HTML string
    function extractRepliesFromHtml(html, parentNumber) {
        const replies = [];
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const replyComments = doc.querySelectorAll('li.comment-item');
        const startIndex = replyComments.length > 0 ? 1 : 0; // Skip parent comment

        for (let i = startIndex; i < replyComments.length; i++) {
            const subComment = extractCommentData(replyComments[i]);
            if (subComment && subComment.text) {
                const subCommentNumber = replies.length + 1;
                subComment.number = `${parentNumber}.${subCommentNumber}`;
                subComment.isSubComment = true;
                subComment.parentNumber = parentNumber;
                replies.push(subComment);
            }
        }
        return replies;
    }

    // --- This function is now replaced by the helpers above ---
    // async function getCommentReplies(commentElement, parentNumber) { ... }
    
    // Extract comments from a single page document (now only processes main comments)
    async function extractCommentsFromDocument(doc) {
        // This function is now effectively replaced by the logic inside extractCommentsFromAllPages
        // Kept for potential future use or to avoid breaking other parts, but the main loop handles it.
        return []; 
    }
    
    // Extract single comment data
    function extractCommentData(element) {
        const numberElement = element.querySelector('.info');
        const number = numberElement ? parseInt(numberElement.textContent.split('.')[0], 10) : 0;
        
        const dateElement = element.querySelector('a[rel="nofollow"]');
        let date = null; // Changed: Default to null instead of now()
        let rawDate = 'N/A';
        if (dateElement) {
            rawDate = dateElement.textContent.replace(/\(.*?\)/g, '').trim();
            const parsedDate = parseGirlsChannelDate(rawDate);
            if (parsedDate) {
                date = parsedDate.toISOString();
            }
        }

        const plusElement = element.querySelector('.icon-rate-wrap-plus p');
        const minusElement = element.querySelector('.icon-rate-wrap-minus p');
        const plus = plusElement ? parseInt(plusElement.textContent, 10) || 0 : 0;
        
        // Fix: Remove the minus sign from the text before parsing
        const minusText = minusElement ? minusElement.textContent.replace(/-/g, '') : '0';
        const minus = parseInt(minusText, 10) || 0;

        const bodyElement = element.querySelector('.body');
        let text = '';
        if (bodyElement) {
            const clone = bodyElement.cloneNode(true);
            clone.querySelectorAll('.res-anchor').forEach(span => span.remove());
            text = clone.textContent.trim();
            
            // Handle image-only comments (same as Python script)
            if (!text || text.startsWith("出典")) {
                const imgTag = bodyElement.querySelector('img[data-src]');
                if (imgTag) {
                    text = imgTag.getAttribute('data-src');
                } else {
                    text = '「画像のURLが見分けられない。」';
                }
            }
        }

        // Capture publisher links wherever GirlsChannel renders them, including
        // plain-text URLs that are not wrapped in the title-link container.
        const urlSet = new Set();
        const addAnchor = anchor => {
            if (/^https?:/i.test(anchor.href)) urlSet.add(anchor.href);
        };
        // GirlsChannel's explicit source link is the strongest candidate.
        element.querySelectorAll('.comment-url-title a[href]').forEach(addAnchor);
        element.querySelectorAll('.body a[href]').forEach(addAnchor);
        const plainTextUrls = (bodyElement?.innerText || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
        plainTextUrls.forEach(url => urlSet.add(url.replace(/[),.;!?\]}〉》」』】、。！？）]+$/g, '')));
        const urls = Array.from(urlSet);

        return {
            number,
            date,
            rawDate,
            plus,
            minus,
            total: plus + minus,
            text,
            urls,
            header: number === 1 ? getTopicTitle() : ''
        };
    }
    
    // New function to calculate activity score
    function calculateActivityScore(comments) {
        if (!comments || comments.length === 0) {
            return { score: 1, labelKey: 'activityInactive' };
        }

        const now = new Date();
        const counts = {
            hour: 0,
            day: 0,
            week: 0,
            month: 0
        };

        const timeLimits = {
            hour: now.getTime() - (60 * 60 * 1000),
            day: now.getTime() - (24 * 60 * 60 * 1000),
            week: now.getTime() - (7 * 24 * 60 * 60 * 1000),
            month: now.getTime() - (30 * 24 * 60 * 60 * 1000)
        };

        for (const comment of comments) {
            const commentDate = new Date(comment.date);
            if (commentDate.getTime() > timeLimits.hour) counts.hour++;
            if (commentDate.getTime() > timeLimits.day) counts.day++;
            if (commentDate.getTime() > timeLimits.week) counts.week++;
            if (commentDate.getTime() > timeLimits.month) counts.month++;
        }

        if (counts.hour > 25) return { score: 10, labelKey: 'activityOnFire', counts };
        if (counts.hour > 10) return { score: 9, labelKey: 'activityVeryActive', counts };
        if (counts.day > 50) return { score: 8, labelKey: 'activityActive', counts };
        if (counts.day > 10) return { score: 7, labelKey: 'activityLively', counts };
        if (counts.day > 0) return { score: 6, labelKey: 'activityModerate', counts };
        if (counts.week > 10) return { score: 5, labelKey: 'activitySteady', counts };
        if (counts.week > 0) return { score: 4, labelKey: 'activityQuiet', counts };
        if (counts.month > 5) return { score: 3, labelKey: 'activitySlow', counts };
        if (counts.month > 0) return { score: 2, labelKey: 'activityDormant', counts };
        
        return { score: 1, labelKey: 'activityInactive', counts };
    }

    // Get next page URL from any document
    function getNextPageUrlFromDocument(doc) {
        const nextLink = doc.querySelector('.pager-topic .next a');
        return nextLink ? nextLink.href : null;
    }
    
    // Fetch page content through background script to avoid CORS issues
    function isAnalysisCancelled(analysisId) {
        return cancelledAnalysisIds.has(analysisId);
    }

    async function fetchPage(url, analysisId = activeAnalysisId) {
        if (isAnalysisCancelled(analysisId)) throw new Error('Extraction aborted by user');
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
                { action: 'fetchPage', url: url, analysisId },
                response => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else if (response && response.success) {
                        resolve(response.html);
                    } else {
                        reject(new Error(response?.error || 'Failed to fetch page'));
                    }
                }
            );
        });
    }
    
    // Send progress update
    function sendProgress(progressData, analysisId = activeAnalysisId) {
        try {
            // If it's a simple string, wrap it in an object for consistency
            const payload = (typeof progressData === 'string')
                ? { type: 'message', text: progressData }
                : progressData;

            chrome.runtime.sendMessage({
                action: 'extractionProgress',
                analysisId,
                data: payload
            });
        } catch (error) {
            console.warn('Could not send progress update.', error);
        }
    }
    
    // Sleep utility
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    debugLog('GirlsinSight content script loaded and logic initiated.');
})();
