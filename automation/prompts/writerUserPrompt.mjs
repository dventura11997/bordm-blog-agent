const FORMAT_GUIDES = {
  news: {
    label: 'NEWS',
    rules: `- Report the facts from the source. Do not invent any detail not present in the source content.
- Structure: lead paragraph with the key news -> supporting details -> what it means for fans.
- End the body with a hyperlink crediting the primary source outlet.
- Australian English throughout.`,
    buildContext: (s) =>
      `Primary Source: ${s.sourceName}\nPrimary URL (use this for attribution): ${s.selectedUrl}\n\nSource content:\n${s.fetchedContent}`,
  },

  ranking: {
    label: 'OPINION',
    rules: `- Take a strong, clear position and defend it. Do not sit on the fence.
- Write in first-person plural (we/us). Be direct and opinionated.
- Structure: bold opening claim -> 2-3 evidence sections from the show -> conclusion that doubles down on the position.
- Australian English throughout.
- Do NOT cite a specific source. Set sourceUrl and sourceName to "" in your JSON output.`,
    buildContext: (s) =>
      `Topic: ${s.selectedTitle}\n\nBackground context from the anime community (use for lore accuracy, do not cite directly):\n${s.fetchedContent?.slice(0, 4000) || ''}`,
  },

  spotlight: {
    label: 'OPINION',
    rules: `- Celebrate a specific character moment, introduction, or defining trait with genuine enthusiasm.
- Write in first-person plural (we/us). Be passionate and personal.
- Structure: set the scene -> describe the moment or trait in vivid detail -> why it's the best ever -> its lasting impact on the show or the fandom.
- Australian English throughout.
- Do NOT cite a specific source. Set sourceUrl and sourceName to "" in your JSON output.`,
    buildContext: (s) =>
      `Topic: ${s.selectedTitle}\n\nBackground context from the anime community (use for lore accuracy, do not cite directly):\n${s.fetchedContent?.slice(0, 4000) || ''}`,
  },

  toplist: {
    label: 'OPINION',
    rules: `- The title contains a number -- your list MUST contain exactly that many items, no more, no less.
- Write in first-person plural (we/us).
- Structure: short intro paragraph (2-3 sentences) -> one subheading per item (e.g. ## 5. Item Name) -> 2-3 sentences per item -> brief conclusion.
- Order from least to most impactful, building to a satisfying #1.
- Australian English throughout.
- Do NOT cite a specific source. Set sourceUrl and sourceName to "" in your JSON output.`,
    buildContext: (s) =>
      `Topic: ${s.selectedTitle}\n\nBackground context from the anime community (use for accuracy and inspiration, do not cite directly):\n${s.fetchedContent?.slice(0, 4000) || ''}`,
  },

  explainer: {
    label: 'THEORIES',
    rules: `- Break down how something happened or how a mechanic works. Authoritative but engaging.
- Write in third-person or second-person. Avoid first-person.
- Structure: introduce the question or mystery -> walk through the events or mechanics that explain it -> conclude with what it means for the character or show going forward.
- Australian English throughout.
- Do NOT cite a specific source. Set sourceUrl and sourceName to "" in your JSON output.`,
    buildContext: (s) =>
      `Topic: ${s.selectedTitle}\n\nBackground context from the anime community (use for lore accuracy, do not cite directly):\n${s.fetchedContent?.slice(0, 4000) || ''}`,
  },

  analysis: {
    label: 'THEORIES',
    rules: `- Analyse what makes a character, relationship, or mechanic unique or thematically significant.
- Write in third-person. Thoughtful and specific -- reference actual scenes, arcs, or moments.
- Structure: the surface-level observation -> the deeper lore or thematic implication -> why it matters to the story and to fans.
- Australian English throughout.
- Do NOT cite a specific source. Set sourceUrl and sourceName to "" in your JSON output.`,
    buildContext: (s) =>
      `Topic: ${s.selectedTitle}\n\nBackground context from the anime community (use for lore accuracy, do not cite directly):\n${s.fetchedContent?.slice(0, 4000) || ''}`,
  },
};

function buildMediaSection(s) {
  const parts = [];

  if (s.images?.length > 0) {
    parts.push('AVAILABLE IMAGES (embed 1-3 where contextually relevant using the article-image figure format):');
    s.images.forEach((img, i) => parts.push(`  Image ${i + 1}: ${img.src}${img.alt ? ` -- "${img.alt}"` : ''}`));
  }

  if (s.tweets?.length > 0) {
    parts.push('AVAILABLE TWEETS (embed where relevant using the tweet-embed format):');
    s.tweets.forEach((url, i) => parts.push(`  Tweet ${i + 1}: ${url}`));
  }

  if (s.youtubeEmbeds?.length > 0) {
    parts.push('AVAILABLE VIDEOS (embed if contextually relevant using the video-embed format):');
    s.youtubeEmbeds.forEach((url, i) => parts.push(`  Video ${i + 1}: ${url}`));
  }

  return parts.length > 0 ? '\n\nAVAILABLE MEDIA:\n' + parts.join('\n') : '';
}

export function buildWriterUserPrompt(s) {
  const articleType = s.articleType || 'news';
  const guide = FORMAT_GUIDES[articleType] ?? FORMAT_GUIDES.news;

  return `Write a Bordmmm ${guide.label} article.

FORMAT: ${articleType.toUpperCase()}
RULES:
${guide.rules}

${guide.buildContext(s)}${buildMediaSection(s)}`;
}
