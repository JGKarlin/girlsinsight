// React components for progressive results rendering
const { useState, useEffect, useRef } = React;

// Main Results Component
const AnalysisResults = ({ i18n }) => {
    const [results, setResults] = useState({
        summary: null,
        source: null,
        sourceDetails: null, // Add sourceDetails to state
        sentiment: null,
        topComments: [],
        bottomComments: [],
        stats: null,
        activityStats: null,
        settings: { commentsToDisplay: 5 }
    });
    const [loading, setLoading] = useState({
        summary: true,
        sentiment: true,
        stats: true
    });
    const [isAnalysisComplete, setIsAnalysisComplete] = useState(false);
    const [activeTab, setActiveTab] = useState('top');

    useEffect(() => {
        // Listen for progressive updates from background
        const handleMessage = (message) => {
            if (message.action === 'partialResults') {
                if (message.analysisId !== window.currentAnalysisId) return;
                const { type, data } = message;
                
                switch(type) {
                    case 'summary':
                        setResults(prev => ({ 
                            ...prev, 
                            summary: data.summary,
                            source: data.source,
                            sourceDetails: data.sourceDetails // Correctly set sourceDetails
                        }));
                        setLoading(prev => ({ ...prev, summary: false }));
                        break;
                        
                    case 'sentimentDraft':
                        setResults(prev => ({ ...prev, sentimentDraft: data.text }));
                        break;

                    case 'sentiment':
                        setResults(prev => ({
                            ...prev,
                            sentiment: data.sentiment,
                            sentimentDraft: null
                        }));
                        setLoading(prev => ({ ...prev, sentiment: false }));
                        break;
                        
                    case 'stats':
                        setResults(prev => ({ 
                            ...prev, 
                            stats: data.stats,
                            activityStats: data.activityStats,
                            topComments: data.topComments,
                            bottomComments: data.bottomComments,
                            settings: data.settings || prev.settings
                        }));
                        setLoading(prev => ({ ...prev, stats: false }));
                        break;
                }
            }
        };

        chrome.runtime.onMessage.addListener(handleMessage);
        return () => chrome.runtime.onMessage.removeListener(handleMessage);
    }, []);

    // Expose method to set all results at once
    useEffect(() => {
        window.setAnalysisResults = (data) => {
            setResults({
                summary: data.summary,
                source: data.source,
                sourceDetails: data.sourceDetails, // Also set it here
                sentiment: data.sentiment,
                topComments: data.topComments,
                bottomComments: data.bottomComments,
                stats: data.stats,
                activityStats: data.activityStats,
                settings: data.settings || { commentsToDisplay: 5 }
            });
            setLoading({ summary: false, sentiment: false, stats: false });
            setIsAnalysisComplete(true); // Also mark as complete if setting all at once
        };
        
        // Expose method to clear results when starting new analysis
        window.clearAnalysisResults = () => {
            setResults({
                summary: null,
                source: null,
                sourceDetails: null, // Clear on reset
                sentiment: null,
                topComments: [],
                bottomComments: [],
                stats: null,
                activityStats: null,
                settings: { commentsToDisplay: 5 }
            });
            setLoading({
                summary: true,
                sentiment: true,
                stats: true
            });
            setIsAnalysisComplete(false);
        };
        
        // This is the new signal handler
        window.markAnalysisAsComplete = () => {
            setIsAnalysisComplete(true);
        };
    }, []);

    return React.createElement('div', { className: 'results', style: { display: 'block' } },
        React.createElement(SummarySection, {
            summary: results.summary,
            source: results.source,
            sourceDetails: results.sourceDetails, // Pass down to the component
            loading: loading.summary,
            i18n: i18n
        }),
        React.createElement(SentimentSection, {
            sentiment: results.sentiment,
            draft: results.sentimentDraft,
            loading: loading.sentiment,
            i18n: i18n
        }),
        React.createElement(CommentsSection, {
            topComments: results.topComments,
            bottomComments: results.bottomComments,
            commentsToDisplay: results.settings.commentsToDisplay,
            activeTab: activeTab,
            setActiveTab: setActiveTab,
            loading: loading.stats,
            i18n: i18n
        }),
        React.createElement(StatsSection, {
            stats: results.stats,
            activityStats: results.activityStats,
            loading: loading.stats,
            i18n: i18n,
            scrapeReplies: results.settings?.scrapeReplies
        }),
        React.createElement('div', { className: 'download-btn-container' },
            React.createElement('button', {
                className: 'download-btn',
                id: 'download-btn',
                style: { display: (loading.summary || loading.sentiment || loading.stats || !isAnalysisComplete) ? 'none' : 'inline-block' }
            }, '📥 ' + i18n('downloadButton'))
        )
    );
};

// Summary Section Component
const SummarySection = ({ summary, source, sourceDetails, loading, i18n }) => {
    if (loading) {
        return React.createElement('div', { className: 'summary-section' },
            React.createElement('h3', { className: 'section-title' }, i18n('summaryTitle')),
            React.createElement('div', { className: 'summary-content result-box loading-skeleton' },
                React.createElement('div', { className: 'skeleton-line', style: { width: '90%' } }),
                React.createElement('div', { className: 'skeleton-line', style: { width: '75%' } }),
                React.createElement('div', { className: 'skeleton-line', style: { width: '85%' } })
            )
        );
    }

    const sourceHref = source?.href || null;
    const sourceLabel = source?.label || sourceHref;
    const archiveHref = source?.kind === 'archive' ? source.archiveHref : null;

    return React.createElement('div', { className: 'summary-section' },
        React.createElement('h3', { className: 'section-title' }, i18n('summaryTitle')),
        React.createElement('div', { 
            className: 'summary-content result-box',
            style: { whiteSpace: 'pre-wrap' }
        }, summary || ''),
        source && React.createElement('div', { className: 'source-info', style: { display: 'block' } },
            sourceHref ?
                React.createElement('span', null, 
                    i18n('sourceLabel') + ': ',
                    React.createElement('a', { href: sourceHref, target: '_blank', rel: 'noreferrer' }, sourceLabel),
                    archiveHref && React.createElement(React.Fragment, null,
                        ' · ',
                        React.createElement('a', {
                            href: archiveHref,
                            target: '_blank',
                            rel: 'noreferrer'
                        }, i18n('archivedCopyLabel'))
                    )
                ) : 
                React.createElement('span', null, i18n('sourceLabel')),
            // Render the sourceDetails if it exists
            sourceDetails && React.createElement('div', { className: 'source-details' }, sourceDetails)
        )
    );
};

// Sentiment Section Component. `draft` is the essay text streamed so far.
const SentimentSection = ({ sentiment, draft, loading, i18n }) => {
    const isLoading = loading || !sentiment;
    // A failed or unfinished analysis has no score; 0 is a real score.
    const hasScore = typeof sentiment?.score === 'number';
    const scorePercent = hasScore ? sentiment.score * 10 : 0;
    const showDraft = isLoading && Boolean(draft);

    return React.createElement('div', { className: 'sentiment-section' },
        React.createElement('h3', { className: 'section-title' }, i18n('sentimentTitle')),
        React.createElement('div', { className: 'sentiment-overview sentiment-' + (sentiment?.label || 'neutral') },
            React.createElement('div', { className: 'sentiment-score' },
                React.createElement('div', { className: 'score-label' }, i18n('overallScoreLabel')),
                React.createElement('div', {
                    className: isLoading ? 'score-value pulsating' : 'score-value'
                }, isLoading ? '?' : hasScore ? String(sentiment.score) : '-'),
                React.createElement('div', { className: 'score-bar' },
                    React.createElement('div', { 
                        className: 'score-fill', 
                        style: { width: isLoading ? '0%' : scorePercent + '%' } 
                    })
                )
            ),
            isLoading ?
                React.createElement('div', {
                    className: 'loading-skeleton sentiment-label-placeholder'
                }) :
                React.createElement('div', { 
                    className: 'sentiment-label ' + (sentiment?.label || 'neutral') 
                }, sentiment?.label ? i18n('sentiment' + sentiment.label.charAt(0).toUpperCase() + sentiment.label.slice(1)) : '')
        ),
        React.createElement('div', {
            className: isLoading && !showDraft ? 'sentiment-details result-box loading-skeleton' : 'sentiment-details result-box'
        },
            showDraft ?
                React.createElement('div', { style: { whiteSpace: 'pre-wrap' } }, draft) :
            isLoading ? [
                React.createElement('div', { key: 1, className: 'skeleton-line', style: { width: '95%' } }),
                React.createElement('div', { key: 2, className: 'skeleton-line', style: { width: '88%' } }),
                React.createElement('div', { key: 3, className: 'skeleton-line', style: { width: '92%' } })
            ] : sentiment?.details ? 
                React.createElement('div', {
                    style: { whiteSpace: 'pre-wrap' }
                }, sentiment.details) : ''
        )
    );
};

// Comments Section Component
const CommentsSection = ({ topComments, bottomComments, commentsToDisplay, activeTab, setActiveTab, loading, i18n }) => {
    const renderCommentsList = (comments, loading) => {
        if (loading) {
            return React.createElement('div', { className: 'comments-list' },
                [1, 2, 3].map(i => 
                    React.createElement('div', { key: i, className: 'comment-item loading-skeleton' },
                        React.createElement('div', { className: 'skeleton-line', style: { width: '100%' } }),
                        React.createElement('div', { className: 'skeleton-line', style: { width: '80%' } })
                    )
                )
            );
        }

        return React.createElement('div', { className: 'comments-list' },
            comments.slice(0, commentsToDisplay).map((comment, index) => 
                React.createElement(CommentItem, { key: index, comment: comment })
            )
        );
    };

    return React.createElement('div', { className: 'comments-section' },
        React.createElement('div', { className: 'comments-tabs' },
            React.createElement('button', {
                className: 'tab-btn ' + (activeTab === 'top' ? 'active' : ''),
                onClick: () => setActiveTab('top')
            }, i18n('topCommentsTab')),
            React.createElement('button', {
                className: 'tab-btn ' + (activeTab === 'bottom' ? 'active' : ''),
                onClick: () => setActiveTab('bottom')
            }, i18n('bottomCommentsTab'))
        ),
        React.createElement('div', { className: 'tab-content ' + (activeTab === 'top' ? 'active' : '') },
            renderCommentsList(topComments, loading)
        ),
        React.createElement('div', { className: 'tab-content ' + (activeTab === 'bottom' ? 'active' : '') },
            renderCommentsList(bottomComments, loading)
        )
    );
};

// Comment Item Component
const CommentItem = ({ comment }) => {
    const trimmedText = comment.text.trim();
    
    const parseCommentContent = (text) => {
        // content.js records an image-only comment as the image's URL.
        if (/^https?:\/\/\S+\.(?:jpe?g|png|gif|webp|avif)(?:\?\S*)?$/i.test(text)) {
            return [{ type: 'image', src: text }];
        }

        const imgRegex = /<img\s+src="([^"]+)"[^>]*\/?>/gi;
        const elements = [];
        let lastIndex = 0;
        let match;
        
        while ((match = imgRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                const textBefore = text.substring(lastIndex, match.index).trim();
                if (textBefore) {
                    elements.push({ type: 'text', content: textBefore });
                }
            }
            
            elements.push({ type: 'image', src: match[1] });
            lastIndex = match.index + match[0].length;
        }
        
        if (lastIndex < text.length) {
            const remainingText = text.substring(lastIndex).trim();
            if (remainingText) {
                elements.push({ type: 'text', content: remainingText });
            }
        }
        
        if (elements.length === 0) {
            elements.push({ type: 'text', content: text });
        }
        
        return elements;
    };
    
    const contentElements = parseCommentContent(trimmedText);
    
    const contentHtml = React.createElement('div', { className: 'comment-text' },
        contentElements.map((element, index) => {
            if (element.type === 'image') {
                return React.createElement('img', {
                    key: index,
                    src: element.src,
                    className: 'comment-image',
                    alt: 'User submitted image'
                });
            } else {
                let displayText = element.content;
                if (displayText.length > 200) {
                    displayText = displayText.substring(0, 200) + '...';
                }
                return React.createElement('span', { key: index }, displayText);
            }
        })
    );

    return React.createElement('div', { className: 'comment-item' },
        contentHtml,
        React.createElement('div', { className: 'comment-meta' },
            // new Date(null) would show 1970, so an undated comment shows no date.
            React.createElement('span', { className: 'comment-date' },
                comment.date && !Number.isNaN(new Date(comment.date).getTime())
                    ? new Date(comment.date).toLocaleDateString()
                    : ''
            ),
            React.createElement('div', { className: 'comment-score' },
                React.createElement('span', { className: 'score-badge' }, '+' + comment.plus),
                React.createElement('span', { className: 'score-badge' }, '-' + comment.minus)
            )
        )
    );
};

// Stats Section Component
const StatsSection = ({ stats, activityStats, loading, i18n, scrapeReplies }) => {
    if (loading) {
        return React.createElement('div', { className: 'stats-section' },
            React.createElement('h3', { className: 'section-title' }, i18n('statsTitle')),
            React.createElement('div', { className: 'stats-grid' },
                [1, 2, 3, 4, 5, 6].map(i => 
                    React.createElement('div', { key: i, className: 'stat-item loading-skeleton' },
                        React.createElement('div', { className: 'skeleton-line', style: { width: '60%' } }),
                        React.createElement('div', { className: 'skeleton-line', style: { width: '40%' } })
                    )
                )
            )
        );
    }

    return React.createElement('div', { className: 'stats-section' },
        React.createElement('h3', { className: 'section-title' }, i18n('statsTitle')),
        React.createElement('div', { className: 'stats-grid' },
            React.createElement('div', { className: 'stat-item' },
                React.createElement('div', { className: 'stat-label' }, i18n('commentsAnalyzedLabel')),
                React.createElement('div', { className: 'stat-value' }, stats?.commentsAnalyzed || '-')
            ),
            React.createElement('div', { className: 'stat-item' },
                React.createElement('div', { className: 'stat-label' }, i18n('totalCommentsLabel')),
                React.createElement('div', { className: 'stat-value' }, stats?.totalComments || '-')
            ),
            scrapeReplies && React.createElement('div', { className: 'stat-item' },
                React.createElement('div', { className: 'stat-label' }, i18n('statsTotalCommentsAndReplies')),
                React.createElement('div', { className: 'stat-value' }, stats?.totalCommentsAndReplies || '-')
            ),
            React.createElement('div', { className: 'stat-item' },
                React.createElement('div', { className: 'stat-label' }, i18n('consensusScoreLabel')),
                React.createElement('div', { className: 'stat-value' }, stats?.consensusScore || '-'),
                React.createElement('div', null, stats?.consensusLabel || '')
            ),
            React.createElement('div', { className: 'stat-item' },
                React.createElement('div', { className: 'stat-label' }, i18n('controversyScoreLabel')),
                React.createElement('div', { className: 'stat-value' }, stats?.controversyScore || '-'),
                React.createElement('div', null, stats?.controversyLabel || '')
            ),
            React.createElement('div', { className: 'stat-item' },
                React.createElement('div', { className: 'stat-label' }, i18n('durationLabel')),
                React.createElement('div', { className: 'stat-value' }, stats?.duration || '-')
            ),
            React.createElement('div', { className: 'stat-item' },
                React.createElement('div', { className: 'stat-label' }, i18n('activityScoreLabel')),
                React.createElement('div', { className: 'stat-value' }, activityStats?.score || '-'),
                React.createElement('div', null, activityStats ? i18n(activityStats.labelKey) : '')
            )
        )
    );
}; 
