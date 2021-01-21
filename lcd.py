# This is a command line utility to control the PFC8574 16x2 i2c backpack
import argparse
from RPLCD.i2c import CharLCD

LCD = CharLCD('PCF8574', 0x27)


def write_to_LCD(msg: str):
    LCD.cursor_pos = (0, 0)
    LCD.write_string(msg)


def write_sensor_data_to_LCD(humidity: float, temperature: float):
    lcd_text = f"Temp:     {temperature:.2f}F\r\nHumidity: {humidity:.2f}%"
    write_to_LCD(lcd_text)


def main():
    parser = argparse.ArgumentParser(description="Control the 16x2 LCD")
    parser.add_argument('command', help="write, data, backlight, clear")
    parser.add_argument('--message')
    parser.add_argument('--on')
    parser.add_argument('--off')
    parser.add_argument('--humidity')
    parser.add_argument('--temperature')
    args = parser.parse_args()

    if args.command == 'sensor':
        write_sensor_data_to_LCD(float(args.humidity), float(args.temperature))
    elif args.command == 'write':
        write_to_LCD(args.message)
    elif args.command == 'clear':
        LCD.clear()
    elif args.command == 'backlight':
        if args.on: LCD.backlight_enabled = True
        elif args.off: LCD.backlight_enabled = False
        else: raise ValueError
    else: raise ValueError

    print("Ran successfully!")


main()