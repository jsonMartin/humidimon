*Humidimon* is a `NodeJS` based controller for the raspberry pi that interfaces with DHT22 humidity moisture sensors, 16x2 i2c LCD screens, and web server interface.

*Humidimon* can respond to changes in humidity or temperature with actions, such as controlling GPIO pins on a raspberry pi, turning on or off a device, sending an alert. Possible uses are controlling a humidifier in a room, controlling a heater, automating a greenhouse...the possibilities are endless!

# Features:
- Raspberry Pi Compatable
- DHT22 Sensor Monitoring
- LCD output
- Twilio Notifications
- Customizable Alerts (temperature/humidity range)
- Hook Actions
- Timers
  - Uses the elegant intelligent date parsing framework `datejs`:  [http://date.js.org/](http://date.js.org/)
  - Uses dates such as `10 am` or `11:30 pm`
- Logs to Database (currently set to every 1 min)
- Control AC Power devices via IOT Power Relay.
  - Simply turn on or off power outlets via GPIO pins

# Sample `.env` file
```
ACCOUNT_SID=your account sid
AUTH_TOKEN=your auth token
```

# Sample `config.json` file
```
{
  "TWILIO_SEND_TO_NUMBER": "+1234567890",
  "TWILIO_SEND_FROM_NUMBER": "+1234567890",
  "PORT": "1234",
  "LCD_TIMER_ON_TIME": "11:00 am",
  "LCD_TIMER_OFF_TIME": "11:00 pm",
  "LCD_TIMER": true,

  "NOTIFICATION_THROTTLE_TIME": 1800000,
  "NOTIFICATION_LOWER_TEMPERATURE_LIMIT": 68,
  "NOTIFICATION_UPPER_TEMPERATURE_LIMIT": 74,
  "NOTIFICATION_LOWER_HUMIDITY_LIMIT": 70,
  "NOTIFICATION_UPPER_HUMIDITY_LIMIT": 99,
  "NOTIFICATION_SENSOR_ERROR_LIMIT": 10,

  "LOWER_HUMIDITY_LIMIT_TRIGGER": 85,
  "UPPER_HUMIDITY_LIMIT_TRIGGER": 95,

  "LOWER_TEMPERATURE_LIMIT_TRIGGER": 76.5,
  "UPPER_TEMPERATURE_LIMIT_TRIGGER": 78.5
}
```

# TO-DO
- [ ] Customize DB update frequency in `config.js` file
- [x] Add Endpoint to toggle LCD timer on/off
- [x] Sql Lite
- [x] Add instructions for environment variables
- [x] Add Timer