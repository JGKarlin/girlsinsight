# GirlsInsight

GirlsInsight is a Python tool for advanced sentiment analysis of GirlsChannel.net comments. By analyzing upvoted and downvoted comments, it evaluates themes, emotions, and cultural contexts to provide nuanced insights into online community sentiment. Designed for researchers, analysts, and developers, GirlsInsight simplifies the process of gathering, analyzing, and visualizing large datasets.

---

## Features

- **Web Scraping**: Automatically retrieves comments and metadata from GirlsChannel.net using BeautifulSoup.
- **Sentiment Analysis**: Evaluates community consensus and disagreement by analyzing explicit user feedback through upvotes/downvotes, performing comment content analysis using GPT-4, Claude, or Groq LLMs, conducting comparative analysis between highest and lowest rated comments, and providing quantitative scoring on a 0-10 scale.
- **Data Visualizations**: Creates the following five data visualizations using Matplotlib and Seaborn:
  1. **Most Upvoted Comments Bar Chart**: Shows the distribution of positive ratings for the most highly rated comments in descending order.
  2. **Most Downvoted Comments Bar Chart**: Displays the distribution of negative ratings for the most poorly rated comments in descending order.
  3. **Consistency Comparison Bar Chart**: Compares the consistency scores between highly rated and lowly rated comment groups.
  4. **Overall Agreement Pie Chart**: Visualizes the overall level of community consensus by showing the proportion of agreement versus disagreement.
  5. **Comment Frequency Line Chart**: Tracks how many comments were posted over time, with automatically adjusted time intervals based on the data span.
- **Excel Export**: Saves processed comments and analysis results in `.xlsx` format for further use.
- **Localized Interface**: Outputs results in either English or Japanese, depending on your preference.

---

## Requirements

- **Python**: Version 3.7 or later.
- **Internet**: Required for API integration and data scraping.
- **Dependencies**: Listed in `requirements.txt`.

---

## Setup Instructions

### Step 1: Clone the Repository
To begin, clone this repository to your local machine:
```bash
git clone https://github.com/yourusername/girlsinsight.git
cd girlsinsight
```

### Step 2: Install Dependencies
Install all required Python libraries:
```bash
pip install -r requirements.txt
```

### Step 3: Configure Environment Variables
The script relies on API keys for OpenAI, Anthropic, and Groq services, managed securely through a `.env` file.

#### 3.1 Create a .env File
Create a `.env` file in the root directory with the following format:
```
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
GROQ_API_KEY=your_groq_api_key
```
Replace `your_openai_api_key`, `your_anthropic_api_key`, or `your_groq_api_key` with your actual API credentials. Anthropic and Groq API keys are not required, but an OpenAI key is required.

#### 3.2 Load Environment Variables
The script automatically loads these values using the `dotenv` library:
```python
from dotenv import load_dotenv
load_dotenv()
```

### Step 4: Run the Script
Execute the script to scrape comments, analyze sentiment, and generate outputs:
```bash
python girlsinsight.v1.0.1.py
```

---

## Usage

### Menu Options
1. **Option 1: Analyze a Specific URL**
   - Enter a topic URL from GirlsChannel.net: トピックのURLを入力してください: 
   - The script validates the URL and retrieves the corresponding comments for analysis.
   - Specify:
     - Language for output: Japanese (1) or English (2).
     - AI Model for Summarization: OpenAI, Anthropic, or Groq.

2. **Option 2: Search by Keyword**
   - Enter a search term: 検索キーワードを入力ください: 
   - Select a date range:
     - All time: Press 1
     - Past year: Press 2
     - Past month: Press 3
     - Past week: Press 4
   - The script constructs a search URL, retrieves topic links, and analyzes matching results.
   - Specify:
     - Language for output: Japanese (1) or English (2).
     - AI Model for Summarization: OpenAI, Anthropic, or Groq.
     - AI Model for Sentiment Analysis: OpenAI, Anthropic, or Groq.

3. **Option 3: Help or Quit**
   - Quit the script or request additional help.

---

### Workflow
1. **Web Scraping**: Retrieves comments and metadata based on a provided URL or search term. Filters results by upvotes and downvotes for balanced analysis.
2. **Sentiment Analysis**: Integrates OpenAI and Anthropic APIs to evaluate comments, analyzing emotions, themes, and cultural context.
3. **Localization**: Outputs text summaries and visualizations in either Japanese or English.
4. **Visualization**: Generates line plots and summary charts to track sentiment trends.
5. **Data Export**: Saves results to `.xlsx`, `.png`, and `.txt` files for easy sharing.

---

## Outputs

The script organizes outputs into an `outputs/` directory, which includes:
1. **Excel Files** (`comments_<query>.xlsx`): Contains detailed metadata of comments (e.g., text, upvotes, downvotes, and date).
2. **Text Summaries** (`output_<query>.txt`): Summarizes the community’s sentiment based on upvoted and downvoted comments.
3. **Visualization Files** (`lineplot_<query>.png` and `plot_<query>.png`): Line plots and summary charts showing trends and sentiment scores.

---

## Directory Structure

```
girlsinsight/
│
├── girlsinsight.v1.0.1.py    # Main script
├── requirements.txt          # List of dependencies
├── .env                      # Environment variables (user-provided)
├── outputs/                  # Directory for all generated outputs
│   ├── comments_<query>.xlsx    # Excel data
│   ├── plot_<query>.png         # Visualization files
│   ├── output_<query>.txt       # Text-based summaries
├── LICENSE                   # License file
└── README.md                 # Documentation
```

---

## Sample .env File

Here’s an example of what the `.env` file should look like:
```
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
GROQ_API_KEY=your_groq_api_key
```

---

## Troubleshooting

1. **Missing Dependencies**: Run `pip install -r requirements.txt` to ensure all dependencies are installed.
2. **API Key Issues**: Verify your `.env` file contains valid API keys. Ensure your account has access to the OpenAI, Anthropic, or Groq APIs.
3. **Scraping Errors**: Check that GirlsChannel.net is accessible and functional. Update the scraping logic if the website layout changes.

---

## Contributing

Contributions are always welcome! Please fork the repository, create a feature branch, and submit a pull request.

---

## License

This project is licensed under the MIT License. See the LICENSE file for more information.
