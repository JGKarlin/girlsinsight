# Privacy Policy for GirlsinSight

**Last updated:** November 8, 2026 (applies to version 1.5.0 and later)

## Overview

GirlsinSight is a Chrome extension for analyzing comment threads on GirlsChannel.net. This privacy policy explains what data the extension accesses, how it uses and stores that data, and who receives it.

GirlsinSight has no server of its own. It runs entirely in your browser, and none of your data is sent to the developer.

## Data the extension accesses

**GirlsChannel pages.** On GirlsChannel.net topic pages, the extension reads the topic's title, comment count and page address so it can show them in its side panel. The topic's post date and any links in the topic post come from the topic's first page; if you open the side panel on a later page, the extension loads the first page to read them. When you click **Analyze Topic**, it reads the comments on every page of that topic: comment text, comment numbers, dates, vote counts and any links in the comments. If you turn on **Scrape replies**, it also reads the topic's reply threads.

**Linked article pages.** If the topic post links to an external page, such as a news article, clicking **Analyze Topic** asks Chrome for permission to access that page's site and the Internet Archive (web.archive.org and archive.org). If you allow it, the extension:

- opens the linked page in an inactive tab in your browser;
- reads the article's text and basic details (title, author, publication date and description);
- follows the article's own "next page" links on the same site, up to 10 pages;
- sends a status-only request, without cookies, to the page's address to check whether the page still exists;
- closes the tab when it has finished, fails or is cancelled.

If you decline, the extension does not open external pages. If there is no link, it does not ask.

**Settings.** The extension stores the settings you enter: your Google Gemini API key, your output language and your analysis preferences.

**Tab addresses.** The extension checks the address of the active tab so it can show its side panel on GirlsChannel and turn it off elsewhere. It does not record or transmit these addresses.

GirlsinSight does not collect your browsing history. It reads only GirlsChannel pages and the articles linked from topics you choose to analyze. It does not collect personal information such as your name or contact details, or any financial, health or location information.

## How the data is used

GirlsinSight uses this data only to produce the analysis you request:

- to summarize the topic and its linked article;
- to calculate statistics such as consensus, controversy and activity scores;
- to write the sentiment analysis;
- to display the results, to show them again when you return to the topic, and to create an Excel report when you click **Download Excel**.

Your Gemini API key is used only to authenticate your requests to Google's Gemini API.

## Who receives data

**Google (Gemini API).** When you run an analysis, the extension sends the following to Google's Gemini API together with your API key: the topic title, the opening post, up to 15,000 characters of the linked article's text, and a sample of comments with their vote counts. It also asks the API which models your key can use. Requests are sent with Gemini's `store` option turned off, so Google does not save them in the request logs of your Google AI Studio project. Google's terms and privacy policy for the Gemini API govern how Google otherwise handles this data, which can depend on the kind of account your API key belongs to.

**Internet Archive.** A linked article may appear to have been deleted, meaning its website reports "not found" and no article can be read. In that case the extension sends the article's address to the Internet Archive's Wayback Machine (web.archive.org and archive.org) to look for an archived copy, and may open that copy in the inactive tab. Only the article's address is sent. No comments, settings or API key are sent to the Internet Archive.

**The websites involved.** Opening a linked article works like visiting it yourself. The article's website receives an ordinary request from your browser, which can include your IP address and any cookies you already have for that site, and that site's own privacy policy applies. GirlsChannel.net likewise receives the requests needed to load the topic's pages and reply threads.

**Chrome sync.** Your output language and analysis preferences are kept in Chrome's sync storage. If Chrome sync is turned on, Google syncs them to other browsers where you are signed in to Chrome. Your API key is not synced.

Apart from these, GirlsinSight does not sell user data, does not transfer it to data brokers, does not use it for advertising, and does not share it for any purpose unrelated to the analysis you request.

## How data is stored

- **API key:** Chrome local storage on this device only. Keys saved by version 1.4 or earlier, which used sync storage, are moved to local storage and removed from sync storage.
- **Preferences:** Chrome sync storage.
- **Current topic details** (title, comment count, post date, address and the topic post's links): Chrome local storage on your device.
- **Recent results:** the results of your five most recently analyzed topics, including the comments they analyzed, are saved in Chrome local storage on your device so you can view them again and download the Excel report.
- **Excel reports:** saved to your computer like any other download, only when you click **Download Excel**.

## Data retention

Settings remain until you change them, clear the extension's data or uninstall the extension. The stored topic details are replaced when you open another topic. A saved result is replaced when you analyze the same topic again, and the oldest is removed when you analyze a sixth topic or when storage is full. All stored data is removed when you uninstall the extension. Because GirlsinSight has no server, it keeps no data anywhere outside your browser.

## Your choices

- Analysis runs only when you click **Analyze Topic**. You can stop it at any time with **Stop Analysis**, and closing the side panel stops it too.
- You can decline site access when Chrome asks, or remove it later under `chrome://extensions` → GirlsinSight → **Details** → **Site access**. Without it, the extension does not open linked articles or contact the Internet Archive, and the summary is based on the topic title and opening post instead.
- You can delete your API key by clearing it in the extension's settings, and remove all stored data, including saved results, by uninstalling the extension.

## Chrome Web Store User Data Policy

The use of information received by GirlsinSight adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Changes to this policy

If the data GirlsinSight handles changes, this policy will be updated and the "Last updated" date above revised.

## Contact

Jason G. Karlin  
https://jgkarlin.org
