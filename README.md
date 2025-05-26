# GirlsInsight

GirlsInsight is a Python tool for web scraping and sentiment analysis of GirlsChannel.net comments. By analyzing upvoted and downvoted comments, it evaluates themes, emotions, and cultural contexts to provide nuanced insights into online community sentiment. Designed for researchers, analysts, and developers, GirlsInsight simplifies the process of gathering, analyzing, and visualizing large datasets.

For detailed information about the technical implementation and methodology, please refer to our [Technical Documentation](https://github.com/JGKarlin/GirlsInsight/blob/main/methodology.md).

---

## Quick Start with Google Colab

The recommended way to use GirlsInsight is through Google Colab, which provides a ready-to-use environment with all dependencies pre-installed and asynchronous processing capabilities for optimal web scraping performance.

### Step 1: Access the Notebook
Open the GirlsInsight Jupyter notebook in Google Colab by clicking this link: [GirlsInsight Colab Notebook](https://colab.research.google.com/github/JGKarlin/GirlsInsight/blob/main/girlsinsight.v1.0.1.ipynb)

### Step 2: Set Up Gemini API
1. Visit the [Gemini AI API Key Page](https://aistudio.google.com/app/apikey)
2. Generate your API key
3. In Colab, click the key icon in the sidebar
4. Add a new secret named `GEMINI_API_KEY`
5. Paste your API key as the value

### Step 3: Run the Notebook
1. Run the API key test cell
2. Execute the dependency installation cell
3. Run the main script cell
4. Follow the interactive prompts in the notebook

---

## Features

- **Web Scraping**: Automatically retrieves comments and metadata from GirlsChannel.net using BeautifulSoup.
- **Sentiment Analysis**: Evaluates community consensus and disagreement by analyzing explicit user feedback through upvotes/downvotes, performing comment content analysis using OpenAI, Anthropic, or Gemini LLMs, conducting comparative analysis between highest and lowest rated comments, and providing quantitative scoring on a 0-10 scale.
- **Data Visualizations**: Creates the following five data visualizations using Matplotlib and Seaborn:
  1. **Most Upvoted Comments Bar Chart**
This visualization reveals which comments resonated most strongly with the community by displaying the positive voting scores for the highest-rated comments in descending order. The chart helps identify the most popular opinions, shared experiences, or valued contributions within the discussion. The x-axis represents the ranking hierarchy of community approval, while the y-axis quantifies the actual level of support each comment received. The system intelligently determines how many top comments to analyze using a statistical formula (approximately 0.91% of total comments plus 9 additional comments), ensuring the sample represents genuine community preferences rather than statistical noise. This visualization is crucial for understanding what the community collectively values or agrees with most strongly.
  2. **Most Downvoted Comments Bar Chart** 
This chart exposes the most controversial or rejected viewpoints by showing which comments received the highest number of downvotes. It serves as a window into community boundaries, revealing what opinions, behaviors, or content the group collectively disapproves of or finds problematic. The visualization displays absolute downvote values to clearly show the intensity of negative community response. This analysis is essential for understanding not just what the community supports, but what it actively rejects, providing insight into group norms, values, and social boundaries. The statistical sampling ensures focus remains on genuinely unpopular content rather than random fluctuations.
  3. **Consistency Comparison Bar Chart**
This analytical visualization measures how unified the community is in their approval or disapproval by calculating consistency scores for both popular and unpopular comment groups. The consistency algorithm evaluates whether voting patterns are coherent (indicating strong community consensus) or scattered (suggesting divided opinions). High consistency scores in popular comments suggest the community has clear, shared values about what they appreciate. High consistency in unpopular comments indicates strong agreement about what they reject. Comparing these scores reveals whether the community is more unified in their likes or dislikes, and whether there are clear social norms or if opinions are fragmented.
  4. **Overall Agreement Pie Chart**
This synthesis visualization distills the entire discussion into a single community cohesion metric, showing what percentage of the discourse reflects genuine consensus versus division or uncertainty. By averaging consistency scores from both positive and negative comment analysis, it reveals whether the community has reached meaningful agreement on the topic or remains fractured in their opinions. A high agreement percentage suggests the discussion has produced clear community sentiment, while lower percentages indicate ongoing debate, mixed feelings, or a topic that naturally divides opinion. This metric is particularly valuable for understanding whether a topic has "settled" in community opinion or remains contentious.
  5. **Comment Frequency Line Chart**
This temporal analysis reveals the natural lifecycle and engagement patterns of community discussions by tracking when comments were posted over time. The visualization automatically adapts its time scale based on discussion duration, showing whether conversations were brief and intense, sustained over long periods, or followed specific patterns like initial bursts followed by gradual decline. Peak activity periods often correlate with breaking news, viral moments, or when the topic gained broader attention. The chart helps identify whether discussions were organic community conversations or driven by external events, and reveals how long topics maintain community interest. The 30-day maximum window ensures focus on active discussion periods rather than sporadic late responses.
- **Excel Export**: Saves processed comments and analysis results in `.xlsx` format for further use.
- **Localized Interface**: Outputs results in either English or Japanese, depending on your preference.

---

## Alternative: Local Installation

While the Colab implementation is recommended for its asynchronous processing capabilities, you can also run GirlsInsight locally. Note that the local version (GirlsInsight.v1.0.1.py) uses synchronous processing to ensure discrete interactions with GirlsChannel.net.

### Requirements
- Python 3.7+
- Internet connection
- Dependencies from `requirements.txt`

### Local Setup

1. **Clone the Repository**
```bash
git clone https://github.com/JGKarlin/GirlsInsight.git
cd GirlsInsight
```

2. **Install Dependencies**
```bash
pip install -r requirements.txt
```

3. **Configure Environment**
Create a `.env` file:
```
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
GEMINI_API_KEY=your_gemini_api_key
```

4. **Run the Script**
```bash
python GirlsInsight.v1.0.1.py
```

---

## Usage

### Menu Options
1. **Analyze a Specific URL**
   - Enter a GirlsChannel.net topic URL
   - Choose output language and AI model

2. **Search by Keyword**
   - Enter search term
   - Select date range
   - Choose language and AI models

3. **Help or Quit**
   - Access help documentation or exit

### Workflow
1. Web scraping of comments and metadata
2. Sentiment analysis using selected AI model
3. Output generation in chosen language
4. Data visualization
5. Results export

---

## Outputs

All results are saved in the `outputs/` directory:
- Excel files (`comments_<query>.xlsx`)
- Text summaries (`output_<query>.txt`)
- Data visualizations:　(`plot<query>.png` and `lineplot<query>.png`)

	最も高評価のコメント (Most Upvoted Comments): This visualization displays the distribution of upvotes across the most positively received comments, with the x-axis showing sequential comment numbers and the y-axis representing upvote counts. The declining pattern reveals how community approval is distributed. Higher values indicate stronger community agreement and support for particular viewpoints, while lower values suggest less enthusiastic but still positive reception. The slope of decline indicates how concentrated or dispersed community approval is across comments. This distribution helps identify the relative strength of community support for different perspectives within the discussion.

  最も低評価のコメント (Most Downvoted Comments): This visualization reveals the pattern of downvotes for the most negatively received comments, with downvote counts plotted against sequential comment numbers. Higher values represent strong community disagreement or rejection of certain viewpoints, while lower values indicate less intense but still negative reactions. The rate of decline between highest and lowest values shows how focused or distributed community disapproval is. This pattern reveals the relative intensity of opposition to different perspectives within the discussion.

  一貫性 (Polarization): This visualization compares consistency scores between highly rated and lowly rated comments on a scale of 0-10. The scores for positive and negative comments indicate how unified the community's voting patterns are in each direction. Higher consistency scores indicate strong community agreement in voting behavior, while lower scores suggest more varied reactions. The difference between positive and negative consistency scores reveals whether the community shows more unity in their approval or disapproval, providing insight into the nature of community consensus.

  全体的な合意度 (Overall Agreement Level): This visualization presents the overall distribution of community consensus, divided between agreement and disagreement portions. The relative sizes of these sections indicate the balance between unified and divided opinions within the discussion. Higher agreement percentages indicate stronger community consensus, while larger disagreement portions suggest more controversial or contested topics. The ratio between these values reveals the extent to which the community has reached consensus versus remaining divided on the discussion topic.

  コメントの頻度 (Comment Frequency): This visualization tracks the distribution of comments across the entire discussion period, automatically adapting its time scale based on the span between the earliest and latest comments. The x-axis dynamically adjusts its intervals and format depending on the discussion duration: hourly intervals for discussions under a day, daily for up to a week, every two days for up to a month, monthly for up to a year, and yearly for longer periods. The y-axis represents the number of comments posted during each time interval. Higher values indicate periods of intense community engagement, while lower values show reduced activity. The resulting line pattern reveals the natural evolution of the discussion's intensity, showing how community participation fluctuated throughout the topic's active period. This temporal mapping helps identify peak engagement periods, natural lulls, and the overall rhythm of community participation, with the visualization automatically optimizing its display to best represent discussions of any length - from hours-long exchanges to conversations spanning months or years.

---

## Directory Structure

```
GirlsInsight/
│
├── GirlsInsight_v1_0_1.ipynb     # Colab notebook (recommended)
├── GirlsInsight.v1.0.1.py        # Local script
├── GirlsInsight.v1.0.1.colab.py  # Colab-optimized script
├── requirements.txt              # Dependencies
├── methodology.md               # Technical implementation details
├── .env                          # Environment variables
├── outputs/                      # Generated outputs
│   ├── comments_<query>.xlsx     # Scraped comment data
│   ├── plot_<query>.png         # Bar charts and pie chart
│   ├── lineplot_<query>.png     # Comment frequency over time
│   ├── output_<query>.txt       # Analysis summaries
├── LICENSE
└── README.md
```

---

## Troubleshooting

1. **Dependencies**: Run `pip install -r requirements.txt`
2. **API Keys**: Verify `.env` file configuration
3. **Scraping Issues**: Check GirlsChannel.net accessibility

---

## Contributing

Contributions welcome! Please fork the repository, create a feature branch, and submit a pull request.

---

## License

This project is licensed under the MIT License. See the LICENSE file for details.
