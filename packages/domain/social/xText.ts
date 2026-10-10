import twitterText from 'twitter-text';

/** Inspect ordinary founder X post text without changing approved content.
 * Uses the official parser's v3 weighted, NFC, URL and emoji rules. A valid
 * result is text validation only, never account or publication authority. */
export function inspectXPostText(text:string):{weightedLength:number;remaining:number;valid:boolean}{
 const {weightedLength,valid}=twitterText.parseTweet(text);
 return {weightedLength,remaining:280-weightedLength,valid};
}
