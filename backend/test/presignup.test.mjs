import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
const calls=[]; let users=[];
CognitoIdentityProviderClient.prototype.send=async function(c){calls.push(c.constructor.name+' '+JSON.stringify(c.input));return c.constructor.name==='ListUsersCommand'?{Users:users}:{}};
const {handler}=await import('../src/presignup.mjs');
const ev=(t,u)=>({triggerSource:t,userName:u,userPoolId:'p',request:{userAttributes:{email:'A@x.com'}},response:{}});
users=[{Username:'uuid1',UserStatus:'CONFIRMED',Attributes:[{Name:'email_verified',Value:'true'}]}];
await handler(ev('PreSignUp_ExternalProvider','google_123')); console.log(calls.pop());
users=[{Username:'uuid2',UserStatus:'UNCONFIRMED',Attributes:[]}]; calls.length=0;
let r=await handler(ev('PreSignUp_ExternalProvider','google_123')); console.log(calls.pop(), r.response);
users=[{Username:'google_9',UserStatus:'EXTERNAL_PROVIDER',Attributes:[]}];
try{await handler(ev('PreSignUp_SignUp','uuid'))}catch(e){console.log('blocked:',e.message)}
users=[]; r=await handler(ev('PreSignUp_SignUp','uuid')); console.log('ok signup',r.response);
