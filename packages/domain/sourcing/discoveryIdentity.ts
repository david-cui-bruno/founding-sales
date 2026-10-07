/** Search-title cleanup is a candidate suggestion, never identity evidence. */
export function discoveryFirmName(title:string,url:string):string {
 const original=title.replace(/\s+/gu,' ').trim();
 const parts=original.split(/\s*[|–—]\s*|\s+-\s+/u).filter(Boolean);
 const branded=parts.filter(part=>/\b(?:property (?:group|management)|realty|rentals|PM)\b/iu.test(part)
  &&! /^(?:property management|rhode island|providence|rentals,|sales|top\s|best\s)/iu.test(part));
 return (branded.length===1?branded[0]!:original||new URL(url).hostname).slice(0,300);
}

/** Exact host families only: an ordinary firm's similar name is not a directory. */
export function isDiscoveryDirectory(url:string):boolean {
 const host=new URL(url).hostname.toLowerCase().replace(/\.$/u,'');
 return ['allpropertymanagement.com','propertymanagement.com','propertymanagementlist.com'].some(domain=>host===domain||host.endsWith('.'+domain));
}
