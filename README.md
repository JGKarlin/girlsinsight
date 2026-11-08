# GirlsinSight Chrome Extension

A Chrome extension for analyzing GirlsChannel topics with AI-powered sentiment analysis using Google Gemini API.

## Features

- **Topic Analysis**: Automatically extract and analyze comments from GirlsChannel topics
- **AI-Powered Summaries**: Generate intelligent summaries using Google Gemini API
- **Sentiment Analysis**: Analyze community sentiment with detailed scoring
- **Modern UI**: Clean, responsive interface with real-time progress tracking, rendered via a side panel for easy access.
- **Excel Export**: Download analysis results as a formatted `.xlsx` file.
- **Multi-language Support**: Japanese and English output options
- **Sub-comment Extraction**: Extracts sub-comments/replies.
- **Visualizes Consensus**: Charts and scores to show community agreement and controversy.

## Installation

### Prerequisites
- Google Chrome browser
- Google Gemini API key (get from [Google AI Studio](https://makersuite.google.com/app/apikey))

### Steps
1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the GirlsChannel directory
5. The extension icon should appear in your toolbar

## Setup

1. Click the extension icon in your toolbar
2. Click "Open Settings" or the gear icon
3. Enter your Google Gemini API key
4. Select your preferred language (Japanese/English)
5. Adjust analysis settings as needed
6. Click "Save Settings"

## Usage

1. Navigate to any GirlsChannel topic page (e.g., `https://girlschannel.net/topics/12345/`)
2. Click the GirlsinSight extension icon
3. Click "Analyze Topic" to start the analysis
4. On first use, approve Chrome's optional site-access prompt so linked articles can be opened and read in a background tab
5. Wait for the AI to process comments and generate insights
6. View the results in the popup window
7. Download the Excel report if needed

## Settings

### API Configuration
- **Gemini API Key**: Required for AI analysis.
- **API Key Test**: Validate your API key before starting an analysis.

### Language Preferences
- **Output Language**: Choose between Japanese (日本語) or English.

### Analysis Settings
- **Auto Comment Calculation**: When enabled, the extension automatically determines the optimal number of comments to analyze based on the topic's size.
- **Comments to Analyze**: If auto-calculation is disabled, you can manually set the number of top/bottom comments to analyze (from 5 to 500).
- **Comments to Display**: Controls how many of the top and bottom comments are shown in the results view (from 0 to 10).

### Data & Export Settings
- **Scrape Replies**: Enable this to extract and include sub-comments (replies) in the analysis. This provides deeper context but may increase analysis time.

## File Structure

```
GirlsChannel/
├── manifest.json          # Extension manifest
├── popup.html             # Main popup/side panel interface
├── popup.css              # Styling for the interface
├── popup.js               # Core JavaScript for the popup/side panel
├── popup-react.js         # React components for rendering results
├── background.js          # Background service worker
├── article-pipeline.js    # Live-first article retrieval policy
├── rendered-article-session.js # Reusable background-tab loader
├── _locales/              # Language files for internationalization
│   ├── en/messages.json
│   └── ja/messages.json
├── lib/                   # Third-party libraries
│   ├── react.production.min.js
│   ├── react-dom.production.min.js
│   ├── Readability.js
│   └── xlsx.full.min.js
├── icons/                 # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md              # This file
```

## Technical Details

### Content Script
- Automatically injects into GirlsChannel pages
- Extracts topic titles, comments, and metadata from the page's DOM
- Identifies pagination and reply links
- Uses message passing to request external page data from the background script, avoiding direct CORS-restricted network requests
- Processes vote counts and comment timestamps

### Background Script
- Sends API calls to Google Gemini and orchestrates topic analysis.
- Opens linked articles in one reusable inactive tab, waits for the rendered DOM to stabilize, and extracts bounded article text with Mozilla Readability.
- Tries every live article candidate before consulting the Wayback Machine, which is limited to pages positively identified as deleted.
- Processes comment data and generates insights
- Handles Excel/CSV file generation
- Manages extension settings, analysis orchestration, and export generation.

### Popup Interface
- Real-time analysis progress tracking
- Tabbed interface for top/bottom comments
- Sentiment scoring with visual indicators
- Statistics dashboard
- Download functionality

## API Integration

The extension uses the Google Gemini API for:
- Article/topic summarization
- Sentiment analysis of comments
- Natural language processing

### API Endpoints Used
- `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`

## Privacy & Security

- API calls are made directly to Google's servers
- Linked pages are rendered in a temporary inactive tab after the user grants Chrome's optional site-access permission; the tab is closed after extraction or cancellation.
- Article text and selected comments are sent to Google Gemini for the requested summary and sentiment analysis.
- Your API key is stored in Chrome's sync storage

## Error Handling

The extension includes comprehensive error handling for:
- **Linked-page access failures**: Reports blocked or unavailable pages; Wayback is tried only when the live page is confirmed dead.
- Network connectivity issues
- API rate limits and errors
- Invalid or expired API keys
- Malformed page content
- Missing comments or metadata

## Troubleshooting

### Common Issues

**"Setup required" message**
- Ensure you have entered a valid Gemini API key in settings
- Test the API key using the "Test API Key" button

**Analysis fails**
- Check your internet connection
- Verify your API key is valid and has sufficient quota
- Ensure you're on a valid GirlsChannel topic page. The extension is now more robust against network errors, but a stable connection is still recommended.

**No comments found**
- Make sure you're on a topic page, not a search page
- Some topics may have comments that load dynamically

**Excel download fails**
- Check if downloads are blocked in Chrome
- Ensure you have sufficient disk space

### Debug Mode
1. Open Chrome DevTools (F12)
2. Check the Console tab for error messages
3. Look for network errors in the Network tab

### Testing Sub-Comment Extraction

To verify that sub-comments are being extracted correctly:

1. Navigate to a GirlsChannel topic page with replies.
2. Enable the "Scrape Replies" option in the extension's settings.
3. Run an analysis.
4. Check the exported Excel file or the UI for comments numbered hierarchically (e.g., `35.1`, `35.2`).

**Note:** Sub-comment extraction depends on GirlsChannel's HTML structure. If replies are not being detected, please check:
- Whether the comment has a "件の返信" (replies) link.
- The browser console for any error messages during extraction.

## Contributing

This extension was created by Jason G. Karlin for analyzing GirlsChannel discussions. 

### Development
- Built with vanilla JavaScript (no frameworks)
- Uses Chrome Extension Manifest V3
- Modern CSS with Grid/Flexbox layouts
- Async/await for API calls

## License

This project is for educational and research purposes. Please respect GirlsChannel's terms of service and rate limits.
The bundled Mozilla Readability 0.6.0 library is distributed under the Apache License 2.0; see `lib/LICENSE.md`.

## Changelog

### v1.0.1
- Initial release
- Basic comment extraction and analysis
- Gemini API integration
- Excel export functionality
- Multi-language support
- **Fixed**: Consensus score "Infinity" error
- **Fixed**: Comment extraction stalling issues
- **Added**: Comprehensive error handling and debugging tools

## Support

For issues or questions, please check the troubleshooting section above or review the browser console for error messages.
