# Slack Best Of Album Pick Processor

## Usage
 1. `yarn install`
 1. `yarn start`


If your spreadsheets are setup correctly you should be set.
### Custom Alternative
Get a published CSV URL from Sheets and:

`yarn start --source <your-sheets-url>`

## Sheet format
Your Google Sheet workbook should...
 * Have 1 worksheet per voting user
 * Have sheet names corresponding to usernames
 * Use a leading `_` in the name if you want it skipped
 * Has a header row
 * Has columns ordered as: `rank`, `artist`, `album`, `url`