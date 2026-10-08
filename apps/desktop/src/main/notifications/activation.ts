/** OS metadata identifies an event; it never supplies a destination or a message body. */
export function defaultNotificationActivationIdentifier(input:unknown):string|null{
 if(typeof input!=='object'||input===null||!('identifier' in input)||!('actionIdentifier' in input))return null;
 if(input.actionIdentifier!=='com.apple.UNNotificationDefaultActionIdentifier'||typeof input.identifier!=='string')return null;
 return /^callie-action:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{64}$/u.test(input.identifier)?input.identifier:null;
}
